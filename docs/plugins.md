# Harness plugins

A plugin adds your own Python code to the harness. You install it into an image
built on top of the harness image; the harness finds it when its daemon starts
in a sandbox and calls it at fixed points, called hooks.

Plugins are the supported way to extend the harness. `harness.plugins` is the
only part of the harness with a stable interface; the rest can change in any
release ([Extending devbox](extending.md)).

This first version has one hook, `daemon_start`. Hooks around the stages of a
task come next.

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

Every hook follows the same rules:

- **A plugin cannot stop the daemon.** A hook that raises is logged, and the
  next plugin runs. A hook that calls `sys.exit()` is treated the same way.
- **A hook has a time budget.** When it is used up, the harness logs that and
  moves on. The hook is not stopped: it keeps running on its own thread. Start
  long work with `ctx.spawn` and return.
- **Plugins run one after another**, in `HARNESS_PLUGINS` order, or by name
  when it is unset.

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
differs from its entry point or would share another plugin's settings, an
unsupported `requires_api`, an unknown hook, two methods for one hook, or a
hook that is `async` or has the wrong arguments. Keep it as the last step, so a broken
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
