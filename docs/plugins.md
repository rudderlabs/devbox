# Harness plugins

A plugin adds your own Python code to the harness. You install it into an image
built on top of the harness image; the harness finds it when its daemon starts
in a sandbox and calls it at fixed points, called hooks.

Plugins are the supported way to extend the harness. `harness.plugins` is the
only part of the harness with a stable interface; the rest can change in any
release ([Extending devbox](extending.md)).

There are five hooks: one when the daemon starts, three around the planning
and implementation stages of an assignment, and one at the start of each
follow-up round (a comment, a review or a CI result).

## Write a plugin

A plugin is a Python package with a class that extends `Plugin`:

```python
from harness.plugins import Plugin, PluginContext, hook


class Hello(Plugin):
    name = "hello"
    requires_api = 1

    @hook("daemon_start")
    def greet(self, ctx: PluginContext) -> None:
        greeting = ctx.settings.get("greeting", "hello")
        ctx.log.info("%s from the example plugin", greeting)
```

Its `pyproject.toml` names the class in the `devbox.plugins` entry point group:

```toml
[project.entry-points."devbox.plugins"]
hello = "devbox_hello_plugin:Hello"
```

- `name` is the plugin's name: lowercase letters, digits and underscores,
  starting with a letter. It must equal the entry point name. It must not be
  another loaded plugin's name followed by an underscore: with `foo` loaded,
  `foo_bar` is not, because `foo` would read its settings.
- `requires_api` is the plugin API version the plugin was written for. This
  harness supports version 1.
- The harness creates the class once per daemon process, with no arguments.

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

Every hook follows the same rules:

- **A plugin cannot fail a task or stop the daemon.** A hook that raises is
  logged, and the next plugin runs.
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
    name = "checks"
    requires_api = 1

    @hook("after_planning")
    def choose(self, ctx, plan):
        return {"suites": ["unit"]}

    @hook("after_implementation")
    def report(self, ctx, plan, implementation):
        suites = plan["extensions"]["checks"]["suites"]
        return HookResult(
            data={"passed": True},
            pr_sections=[
                PrSection(repo=repo["name"], title="Checks", body=f"Ran {suites}.")
                for repo in implementation["repos"]
            ],
        )
```

- **Data** is a JSON mapping. The harness stores it under
  `extensions.<plugin name>` in the stage's file, where later hooks of any
  plugin read it. Returning a mapping is the same as `HookResult(data=...)`.
- **A pull request section** has a repository name, a title and a Markdown
  body. The harness appends it to that repository's pull request body as
  `## <title>`. A section for a repository the implementation does not have
  is logged and dropped.
- Returning `None` adds nothing.

A result the hook may not return (data that is not JSON, a section with an
empty title) is logged and dropped as a whole.

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
  `.harness/plugins/_results/<name>/`, outside the plugin's own directory.
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
| `ctx.state_dir` | The plugin's own directory on the task's volume, `.harness/plugins/<name>/`. It survives a sandbox restart. Create it before writing to it. |
| `ctx.runtime_dir` | The plugin's own directory off the volume. A restart empties it. |
| `ctx.workspace` | The workspace root, with each repo below it. |
| `ctx.log` | A `logging.Logger` named `harness.plugins.<name>`. |
| `ctx.task` | The round the hook runs for, an assignment or a follow-up: `task_key`, `inbox_id` and `run_id`. `None` in `daemon_start`. |
| `ctx.say(text)` | Posts a short progress line where the task's person follows the task. It does nothing in `daemon_start`, or for a task whose source shows no progress messages, and never raises. Write it in the first person, about the work. |
| `ctx.spawn(argv, log=..., once=...)` | Starts a detached process and returns its pid without waiting. Its output is appended to `state_dir/<log>`. With `once`, a second call under the same name starts nothing while the first process is alive, and returns `None`. Use `once` for anything that must not run twice, such as a server on a fixed port. |

## Settings

A plugin reads its settings from environment variables named
`HARNESS_PLUGIN_<NAME>_<KEY>`. `HARNESS_PLUGIN_HELLO_GREETING=hi` is
`ctx.settings["greeting"]` in the `hello` plugin.

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
and exits non-zero when one cannot be loaded: an import error, a name that
differs from its entry point, an unsupported `requires_api`, an unknown hook
or a hook with the wrong arguments. Keep it as the last step, so a broken
plugin fails the image build and never reaches a sandbox.

`harness plugins list` shows the plugins the daemon would load and their
hooks.

## Choose which plugins run

`HARNESS_PLUGINS` is a comma-separated list of plugin names. Upper and lower
case are the same.

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

registry = registry_for([Hello], root=tmp_path, env={"HARNESS_PLUGIN_HELLO_GREETING": "hi"})
registry.run("daemon_start")
```

Everything the plugin may write goes under `root`: its state in
`root/state/<name>`, its runtime files in `root/runtime/<name>`, and the
workspace at `root/workspace`.

## Versions

`harness.plugins.API_VERSION` is the plugin API version.

- A new hook or a new context member does not change it.
- Removing a hook or a context member, or changing what one means, raises it.
  The harness then supports the previous version for one more release.
- Pin the harness image your image builds on, and run `harness plugins check`
  and your plugin's tests when you move to a new one.
