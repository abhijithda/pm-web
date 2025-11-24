# A Web UI for Plugin Manager (PM)

A web interface for the Plugin Manager (PM) https://github.com/abhijithda/plugin-manager.

The UI accepts the plugin information that contains the plugin name, description, command to execute and any dependencies.

While the plugin manager is executing plugins in parallel, the UI would show the progress and status of those plugins.

## Run the demo UI

This repository contains a simple frontend-only demo that simulates plugin execution and dependency handling.

To run locally, serve the folder and open `index.html`. For example:

```bash
cd /workspaces/pm-web
python3 -m http.server 8000
# then open http://localhost:8000/index.html in your browser
```

Note: The demo supports importing/exporting plugin lists as JSON.

## TODO

- Make the plugins like a graph showing dependencies - https://github.com/VeritasOS/software-update-manager/blob/v1/samples/update-reboot-commit/imgs/prereboot.svg
- This is a client-side simulation. To integrate with the real `plugin-manager`, connect the UI to an API that starts plugins and reports status/progress.
