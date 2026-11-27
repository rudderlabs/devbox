# Harness plugins

A plugin adds your own Python code to the harness. You install it into an image
built on top of the harness image; the harness finds it when its daemon starts
in a sandbox and calls it at fixed points, called hooks.

Plugins are the supported way to extend the harness. `harness.plugins` is the
only part of the harness with a stable interface; the rest can change in any
release ([Extending devbox](extending.md)).

There are six hooks: one when the daemon starts, three around the planning
and implementation stages of an assignment, one at the start of each
follow-up round (a comment, a review or a CI result), and one that adds text
to an agent's system prompt.

## Write a plugin

A plugin is a Python package with a class that extends `Plugin`:

```python
from harness.plugins import Plugin, PluginContext, hook


class Hello(Plugin):
    name = "example.hello"
    requires_api = 1

    @hook("daemon_start")
    def greet(self, ctx: PluginContext) -> None:
        greeting = ctx.settings.get("greeting", "hello")
        ctx.log.info("%s from the example plugin", greeting)
```

Its `pyproject.toml` names the class in the `devbox.plugins` entry point group:

```toml
[project.entry-points."devbox.plugins"]
"example.hello" = "devbox_hello_plugin:Hello"
```

- `name` is the plugin's name, written `<namespace>.<name>`. The namespace
  says whose plugin it is: use your organization or project, so your `warmup`
  and someone else's can be installed side by side. Each part is lowercase
  letters, digits and underscores, starting with a letter. The name must equal
  the entry point name, which TOML needs in quotes because of the dot.
- Two loaded plugins must not share settings. A setting's variable name has
  an underscore where the plugin name has its dot, so with `acme.foo` loaded,
  `acme.foo_bar` is not, because `acme.foo` would read its settings.
- `requires_api` is the plugin API version the plugin was written for. This
  harness supports version 1.
- The harness creates the class once per daemon process, with no arguments.
  It imports and creates a plugin on a thread of its own, so a plugin must
  not install signal handlers when it loads.
- A hook is a plain method marked with `@hook`, one per hook name. An `async`
  method or a generator is rejected when the plugin loads, because calling
  one would run none of its body.

[harness/examples/plugins/hello](../harness/examples/plugins/hello) is this
plugin as a complete package.

## Hooks

| Hook | Arguments | Budget | When |
|---|---|---|---|
| `daemon_start` | `ctx` | 10 seconds | Once per daemon process, after the harness has set itself up and before it reads its first inbox file. A sandbox recreated from its volume starts a new daemon, so the hook runs again there. |
| `after_planning` | `ctx`, `plan` | 5 minutes | Once per assignment, after the plan is written. |
| `before_implementation` | `ctx`, `plan` | 30 seconds | Each time the daemon is about to run or resume an assignment's implementation. A restart in the middle of implementation runs it again. It does not run once the implementation is complete. |
| `after_implementation` | `ctx`, `plan`, `implementation` | 30 minutes | Once per assignment, after every repository's implementation is complete. Before the review, except after a failed first try ([Restarts](#restarts)). |
| `followup_start` | `ctx`, `kind` | 30 seconds | Each time the daemon is about to run or resume a follow-up round, before its agent runs. `kind` is the round's inbox kind: `comment`, `review` or `ci_result`. It does not run for a round whose agent has already finished. |
| `prompt_fragments` | `ctx`, `stage` | 10 seconds | Each time the daemon is about to start the agents of a stage. Returns text for their system prompt ([below](#add-text-to-an-agents-system-prompt)). |

Every hook follows the same rules:

- **A plugin cannot fail a task or stop the daemon.** A hook that raises is
  logged, and the next plugin runs. A hook that calls `sys.exit()` is treated
  the same way.
- **A hook has a time budget.** When it is used up, the harness logs that and
  moves on, and drops whatever the hook returns later. The hook is not
  stopped: it keeps running on its own thread. Start long work that needs no
  answer with `ctx.spawn` and return.
- **Plugins run one after another**, in `HARNESS_PLUGINS` order, or by name
  when it is unset.

In a follow-up round the agent makes its change, commits and pushes within one
session, so there is no hook between the change and the push.

### What a stage hook gets

`plan` and `implementation` are the contents of `.harness/plan.json` and
`.harness/implementation.json`, as dictionaries. Each plugin gets its own
copy, so changing one changes nothing. Only the `extensions` key (below) is
part of the plugin interface. The other keys are the harness's own and can
change.

### What a stage hook may return

`after_planning` and `after_implementation` may return data, and
`after_implementation` may also return sections for the pull request bodies:

```python
from harness.plugins import HookResult, Plugin, PrSection, hook


class Checks(Plugin):
    name = "acme.checks"
    requires_api = 1

    @hook("after_planning")
    def choose(self, ctx, plan):
        return {"suites": ["unit"]}

    @hook("after_implementation")
    def report(self, ctx, plan, implementation):
        suites = plan["extensions"]["acme.checks"]["suites"]
        return HookResult(
            data={"passed": True},
            pr_sections=[
                PrSection(repo=repo["name"], title="Checks", body=f"Ran {suites}.")
                for repo in implementation["repos"]
            ],
        )
```

- **Data** is a JSON mapping. The harness stores it under
  `extensions["<namespace>.<name>"]` in the stage's file, where later hooks of any
  plugin read it. Returning a mapping is the same as `HookResult(data=...)`.
- **A pull request section** has a repository name, a title and a Markdown
  body. The harness appends it to that repository's pull request body as
  `## <title>`. A section for a repository the implementation does not have
  is logged and dropped.
- Returning `None` adds nothing.

A result the hook may not return (data that is not JSON, a section with an
empty title) is logged and dropped as a whole.

### Add text to an agent's system prompt

`prompt_fragments` tells an agent something the harness cannot know: a command
your image adds, a service your plugin has started, a rule of your
organization.

```python
@hook("prompt_fragments")
def instructions(self, ctx: PluginContext, stage: str) -> str | None:
    if stage == "implementation":
        return "Run `stack status` before you test against the local stack."
    return None
```

`stage` names the agents that get the text:

| `stage` | Agents |
|---|---|
| `planning` | The planning agent of each repository. |
| `implementation` | The implementation agent of each repository. |
| `review_fix` | The agent that fixes what the harness's own review of the change found, one per repository. |
| `comment`, `review`, `ci_result` | The agent of that follow-up round. `review` is a person's review of the pull request. |

Orientation, plan review, the review's own agents that read the change, and
distillation take no plugin text.

- Return a string, a list of strings, or `None` for no text.
- The harness adds the text to the system prompt in a block that names your
  plugin: `<plugin_instructions plugin="<namespace>.<name>">`. It comes after the stage's
  own instructions, but it is not always the last thing in the prompt.
- One plugin may add up to 8,000 characters per stage. Longer text is logged
  and dropped whole.
- The hook runs once per stage, just before its agents start, and every agent
  of the stage gets the same text. When that is depends on the stage:
  - `planning`: before planning starts. No plan exists yet, and neither
    `after_planning` nor `before_implementation` has run.
  - `implementation`: after `before_implementation`.
  - `review_fix`: when the review begins, whether or not the review then
    finds something to fix.
  - `comment`, `review`, `ci_result`: after `followup_start`.
- The text is not saved. After a restart the hook runs again, and a resumed
  agent gets what it returns then.
- The hook has no plan argument. To make the text depend on the plan, save
  what you need under `ctx.state_dir` in `after_planning`, keyed by
  `ctx.task.inbox_id`.

The text is an instruction to a model, not a control. Enforce anything that
must hold in your own code.

### Restarts

The harness restarts an assignment where it stopped. For the two hooks that
return a result:

- The result is saved on the task's volume before it is used,
  keyed by the assignment's inbox id. After a restart the saved result is used
  again and the hook is not called.
- A hook that raised or ran out of budget saved nothing. A restart calls it
  again.
- A task that is assigned again is a new assignment, and its hooks run again.
- `after_implementation` normally runs before the review. When it raised or
  ran out of budget and the daemon then restarts, it is called again wherever
  the assignment has got to, which can be after the review or after the pull
  request is open. Data it returns then is still kept. A pull request section
  it returns then does not reach a pull request that is already open: the
  harness reuses an open pull request without changing its body.
- Saved results stay on the task's volume, under
  `.harness/plugins/_results/<namespace>.<name>/`, outside the plugin's own directory.
  They are small and the harness does not
  remove them.

So a result-returning hook runs at most once per assignment when it
succeeds. Make anything it does outside its return value safe to repeat.

## The context

Each hook gets a `PluginContext`, built for that call:

| Member | What it is |
|---|---|
| `ctx.name` | The plugin's name. |
| `ctx.settings` | The plugin's settings (below). |
| `ctx.state_dir` | The plugin's own directory on the task's volume, `.harness/plugins/<namespace>.<name>/`. It survives a sandbox restart. Create it before writing to it. |
| `ctx.runtime_dir` | The plugin's own directory off the volume. A restart empties it. |
| `ctx.workspace` | The workspace root, with each repo below it. |
| `ctx.log` | A `logging.Logger` named `harness.plugins.<namespace>.<name>`. |
| `ctx.task` | The round the hook runs for, an assignment or a follow-up: `task_key`, `inbox_id` and `run_id`. `None` in `daemon_start`. |
| `ctx.say(text)` | Posts a short progress line where the task's person follows the task. It does nothing in `daemon_start`, or for a task whose source shows no progress messages, and never raises. Write it in the first person, about the work. |
| `ctx.spawn(argv, log=..., once=...)` | Starts a detached process and returns its pid without waiting. Its output is appended to `state_dir/<log>`. With `once`, a second call under the same name starts nothing while the first process is alive, and returns `None`. Use `once` for anything that must not run twice, such as a server on a fixed port. |

## Settings

A plugin reads its settings from environment variables named
`HARNESS_PLUGIN_<NAMESPACE>_<NAME>_<KEY>`: the plugin's name in upper case
with its dot as an underscore, then the key.
`HARNESS_PLUGIN_EXAMPLE_HELLO_GREETING=hi` is `ctx.settings["greeting"]` in
the `example.hello` plugin.

Set them with `ENV` in your image. The control plane does not forward
`HARNESS_PLUGIN_*` variables to sandboxes: it forwards only the names in its
allowlist (`control-plane/src/forwardedEnv.ts`).

Never put a real secret in a setting. A sandbox holds no real credentials;
iron-proxy adds them to requests on the way out.

## Add a plugin to the harness image

Build an image on top of the harness image
([Extending the harness image](kubernetes/harness-image.md)) and install the
plugin into the harness's environment:

```dockerfile
ARG DEVBOX_VERSION=0.2.0
FROM rudderlabs/devbox-harness:${DEVBOX_VERSION}

COPY my-plugin/ /opt/plugins/my-plugin/
RUN uv pip install --python /opt/harness/.venv/bin/python /opt/plugins/my-plugin \
    && harness plugins check
```

`harness plugins check` loads every installed plugin the way the daemon does
and exits non-zero when one cannot be loaded: an import error, a name without a namespace, a
name that differs from its entry point or would share another plugin's settings, an
unsupported `requires_api`, an unknown hook, two methods for one hook, or a
hook that is `async` or has the wrong arguments. Keep it as the last step, so a broken
plugin fails the image build and never reaches a sandbox.

`harness plugins list` shows the plugins the daemon would load and their
hooks.

## Choose which plugins run

`HARNESS_PLUGINS` is a comma-separated list of plugin names, each with its
namespace: `acme.warmup,acme.verify`. Upper and lower case are the same.

- Unset or empty: every installed plugin runs, ordered by name.
- A list: only those plugins run, in that order. A listed name that is not
  installed is logged.
- `none`: no plugin runs.

The control plane forwards it to sandboxes, so on Kubernetes you can turn a
plugin off with `extraEnv`, without building a new image.

## What happens when a plugin is broken

The daemon never fails because of a plugin. A plugin that cannot be loaded is
logged (`daemon: plugin not loaded: …`) and left out, and the others run. The
build-time check is what keeps a broken plugin out.

## Test a plugin

`harness.plugins.testing.registry_for` builds a registry from plugin classes,
without installing them or starting a daemon. It checks each class the way the
loader does, and raises on one that would not load:

```python
from harness.plugins.testing import registry_for

registry = registry_for([Hello], root=tmp_path, env={"HARNESS_PLUGIN_EXAMPLE_HELLO_GREETING": "hi"})
registry.run("daemon_start")
```

Everything the plugin may write goes under `root`: its state in
`root/state/<namespace>.<name>`, its runtime files in
`root/runtime/<namespace>.<name>`, and the
workspace at `root/workspace`.

## Versions

`harness.plugins.API_VERSION` is the plugin API version.

- A new hook or a new context member does not change it.
- Removing a hook or a context member, or changing what one means, raises it.
  The harness then supports the previous version for one more release.
- Pin the harness image your image builds on, and run `harness plugins check`
  and your plugin's tests when you move to a new one.
