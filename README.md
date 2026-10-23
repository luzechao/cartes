# cartes

A two-way 3D geometry editor for EnergyPlus IDF files that runs entirely in the browser, and runs
EnergyPlus there too.

**Try it: https://luzechao.github.io/cartes/** — open an IDF, or pick one from **Geometry → Examples**.
Files are read locally and never uploaded.

## What it does

Open an existing `.idf`, see its geometry in 3D, edit it, simulate it, and write it back
**without disturbing the rest of the file**. No install, no CAD license, no server.

- **Lossless round-trip.** Any IDF comes back byte-for-byte; an edit changes only the bytes it
  should.
- **3D view.** Shows world and relative coordinates correctly. Color by surface type or
  construction, pull stories apart or show one at a time, share a view as a link, save it as an
  image.
- **Validation as EnergyPlus does it.** The enclosure and upside-down checks agree with
  EnergyPlus on every case measured. Every other class is checked field by field against the
  full EnergyPlus schema: choices, numbers, bounds, required fields and dangling references.
- **Every class in the Inspector.** Field names, units, choices, defaults, notes, value checks and
  name suggestions for reference fields, for all ~850 classes, with a link to the I/O Reference.
- **Geometry editing.** Drag vertices and building corners with vertex, edge and grid snapping.
  Add and delete vertices and move zones. Interzone twins stay in step, and everything can be
  undone.
- **Authoring.** Draw zone footprints and extrude them; place windows and doors.
- **Surface matching.** Find the interzone pairs the geometry implies, and review them before
  anything is written.
- **Simplified surfaces.** Convert EnergyPlus's rectangular classes to explicit vertices,
  computed as EnergyPlus computes them.
- **Simulation in the browser.** Run the current model, unsaved edits included, through
  EnergyPlus 26.1 compiled to WebAssembly, with **PythonPlugin** support. See
  [Simulating](#simulating).
- **Agent.** Chat with a language model that reads, edits, simulates and analyses the open model
  through cartes' own tools, with each edit approved first by default. See [Agent](#agent).
- **MCP server.** Drive the same operations from an LLM outside the browser.

## Why it exists

Every other tool in building-energy modeling is a *generator*: you author in the tool's own model
and translate to IDF, one way. None can open an arbitrary existing IDF and edit it, except Euclid,
which no longer runs on SketchUp 2024+.

| Tool | Author → IDF | Open existing IDF | Edit it | Free | Browser |
|---|:---:|:---:|:---:|:---:|:---:|
| OpenStudio SketchUp Plug-in | ✓ (via OSM) | partial, lossy | ✓ | plugin only | ✗ |
| VI-Suite (Blender) | ✓ | ✗ | ✗ | ✓ | ✗ |
| Ladybug / Honeybee, Pollination | ✓ | ✗ | ✗ | mixed | ✗ |
| FloorspaceJS | ✓ (2D, via OSM) | ✗ | ✗ | ✓ | ✓ |
| EPShape | ✗ | ✓ | ✗ (read-only) | ✓ | ✓ |
| Euclid | ✓ | ✓ | ✓ | plugin only | ✗ (dead on SketchUp 2024+) |
| **cartes** | ✓ | ✓ | ✓ | ✓ | ✓ |

The niche is not a free alternative to SketchUp. It is **the successor to Euclid**: lossless
round-trip editing of native IDF geometry, in a browser. See
[`docs/01-landscape.md`](docs/01-landscape.md) for the full survey.

## Scope

**Zero wall thickness.** Surfaces are the atoms of the model, exactly as EnergyPlus sees them.
This keeps the editor's model 1:1 with the IDF, which is what makes lossless round-trip
tractable; it sidesteps the physical-versus-analytical model split that makes BIM hard. Thick-wall,
architectural authoring is out of scope. [`docs/04-architecture.md`](docs/04-architecture.md)
§Where thickness attaches later describes how it would be added.

## Status

The nine phases of [`docs/05-implementation-plan.md`](docs/05-implementation-plan.md) are complete,
and in-browser simulation has been added on top. The suite has about 700 tests over 182 real
EnergyPlus files spanning nine releases. Every geometry-changing operation is also gated against
EnergyPlus 26.1 itself: the edited file must run without new severe errors.

## Simulating

The ribbon's **Simulate** tab runs the current model through EnergyPlus 26.1.0 in a Web Worker,
using [`@luzechao/sim-engine-wasm`](https://github.com/luzechao/browser-energy-simulation/tree/main/packages/sim-engine-wasm):
EnergyPlus compiled to WebAssembly and loaded into Pyodide 314. The sidebar follows the ribbon:
Geometry shows Inspector, Validation and Matching; Simulate shows Simulate and Python; Agent shows
Chat.

- **Inputs.** Load an EPW weather file, or **Find weather**: search about 69,000 TMYx stations
  from climate.onebuilding.org by place or near the model's Site:Location, and use one. Without
  weather, only the model's design days run (`energyplus -D`). Load the `.py` modules named by `PythonPlugin:Instance` objects, and list any
  Pyodide packages they import, such as `numpy`.
- **Results.** The sidebar's Simulate tab shows the run status, the live EnergyPlus console, the
  warning, severe and fatal messages, and every output file to download. **Report** opens
  `eplustbl.htm`.
- **Python.** **Simulate → Python** opens a Python REPL in the same Pyodide interpreter that runs
  PythonPlugins, with EnergyPlus loaded. `api` is pyenergyplus's `EnergyPlusAPI`, and `last_run` is
  the last simulation's output directory, so `open(f"{last_run}/eplusout.err").read()` works.
  Pyodide packages are fetched when imported, and top-level `await` is allowed. **Restart**
  replaces the interpreter, which is the way out of code that never returns. It works with no model
  open.
- **Examples.** **Geometry → Examples** opens two EnergyPlus 26.1 models from `public/examples/`,
  `5ZoneAirCooled` and `PythonPluginCustomOutputVariable`, with the Chicago weather file and, for
  the second, its plugin module, so they run in one click.
- **Versions.** The engine reads version 26.1 IDFs. Newer files run with a version warning; older
  ones should be migrated with IDFVersionUpdater first. The panel says when a file's version
  differs.
- **Download size.** The engine (~33 MB) and Pyodide's runtime (~15 MB) load the first time the
  Simulate tab is opened, and are cached afterwards. Nothing is sent to a server; only Pyodide
  packages listed in Packages are fetched, from the Pyodide CDN.

Not available in the browser build: ExpandObjects (`HVACTemplate:*`), the Slab and Basement
preprocessors, PixelCounting shading (EnergyPlus falls back to PolygonClipping) and
`ExternalInterface`.

## Agent

The ribbon's **Agent** tab puts a chat in the sidebar. The agent works on the open model through
the same tools as the [MCP server](#getting-started), so it gets the same guarantees as the UI:
field-level writes, twins kept in step, proposals before matching.

- **Providers.** OpenAI, Anthropic, or any OpenAI-compatible URL (Ollama, LM Studio, vLLM,
  OpenRouter and similar), through the [Vercel AI SDK](https://ai-sdk.dev). Requests go straight
  from the browser to the provider with your own key; there is no cartes server. Keys stay in
  `sessionStorage` and are forgotten when the tab closes, unless **Remember keys** is checked. A
  local server must allow cross-origin requests from the page (for Ollama, set `OLLAMA_ORIGINS`).
- **Tools.** Reading: `summary`, `list_objects`, `list_zones`, `list_surfaces`, `inspect`,
  `validate`, `diff`, `propose_matches`, and `find_classes` and `describe_class` over every
  EnergyPlus class. Geometry edits: `extrude_zone`, `add_opening`, `move_zone`, `delete_surface`,
  `apply_matches`, `convert_simplified`. Edits to any class: `set_field`, `update_object`,
  `add_object`, `rename_object` (references follow), `duplicate_object` and `remove_object`
  (refused while referenced unless forced). Values the schema forbids are refused with the
  reason. `undo` and `redo`; `run_python` in the
  REPL's Pyodide interpreter, with `last_run` and `api` (for calculation and reading results;
  Python cannot change the model); and `run_simulation`, with the Simulate tab's weather and
  plugins. Opening, saving and replacing the file stay with the user.
- **Edits.** **Ask before edits** (the default) holds each edit until you approve it on its card in
  the chat. A rejected edit is reported back to the agent, which is told not to retry it.
  **Apply automatically** skips the question. Either way, each tool call is one undo step, labelled
  "Agent: …", in the app's own history.
- **Settings, loads, outputs.** `get_simulation_settings` and `set_simulation_settings` (time
  step, run period, SimulationControl); `inspect_loads` (people, lights, equipment, infiltration
  and ventilation, with per-floor-area values) and `scale_loads`, which multiplies whichever field
  each object's calculation method reads; `add_outputs` for variables and meters.
- **Results.** `results_summary` (site and source energy, EUI, end uses by fuel, unmet hours),
  `list_report_tables` and `get_report_table` for the tabular reports, `list_output_variables`
  (reported, and requestable from the `.rdd`/`.mdd`), `get_timeseries` (statistics and monthly
  values, aggregated in SQL) and `query_results` (one read-only SELECT). They read the last run's
  `eplusout.sql` with Python's `sqlite3` in the Pyodide interpreter. `run_simulation` adds
  `Output:SQLite`, `Output:VariableDictionary` and `Output:Table:SummaryReports` to the text it
  simulates when the model lacks them; the model itself is not changed.
- **Weather.** `search_weather`, `use_weather`, and `apply_design_conditions`, which replaces the
  design days with the station's DDY (annual 99.6% heating and 0.4% cooling by default) and sets
  Site:Location.
- **Context.** Each turn tells the agent the file, its counts and validation state, the selected
  object, the weather file and the last run.

The AI SDK loads only when the first message is sent, so it adds nothing to the app's initial
download.

## Weather downloads

The station index is served with the app, so searching works offline. Downloading does not:
climate.onebuilding.org sends no CORS header, so a web page cannot fetch its files. Set a weather
proxy in **Simulate → Find weather**: `{url}` in it is replaced by the file's address, or the
address is appended. [`proxy/weather-proxy.js`](proxy/weather-proxy.js) is a Cloudflare Worker
that forwards climate.onebuilding.org files only. Without a proxy, the dialog gives the
download link, and the EPW inside can be loaded with **Weather**.

## Full schema

The model layer's own IDD table covers the geometry classes across 27 releases. Everything else
comes from [`@idfkit/schemas`](https://github.com/idfkit/idfkit-js) (every class, 8.9 to 26.2,
~1 MB gzipped) with validation and descriptions from `@idfkit/core`. cartes still owns the
document and every write; idfkit only reads. The bundle is copied to `public/schemas/` by
`predev`/`prebuild` (`scripts/copy-data.mjs`) and fetched when a file is opened.

Field checks follow idfkit's codes (E002–E010) with one exception: `Autosize` and `Autocalculate`
are accepted for each other. EnergyPlus does the same, and 836 such values occur in 164 of its own
example files.

## Getting started

```bash
npm install
npm run setup      # fetch IDDs, build the field table, fetch fixtures (~160 MB, gitignored)
npm test
npm run dev        # the editor, at http://localhost:5173
```

`npm run setup` downloads from the EnergyPlus repository. Nothing large is committed: the 27
archived IDDs and the fixture corpus are build inputs, and the generated field table is rebuilt by
`npm run preprocess-idd`. The corpus is pinned to one EnergyPlus commit and verified file by file
against `test/fixtures/testfiles.manifest`, so every checkout tests the same bytes.

`npm run dev` and `npm run build` first copy the simulation engine and Pyodide runtime into
`public/sim-engine/` (gitignored) with `sim-engine-wasm-assets`. The package comes from the
CI-built tarball on its [GitHub Release](https://github.com/luzechao/browser-energy-simulation/releases/tag/sim-engine-wasm-v26.1.0);
once it is on the npm registry, `npm install @luzechao/sim-engine-wasm@^26.1.0` replaces it.

Other commands:

```bash
npm run test:eplus # the EnergyPlus gates (need a native EnergyPlus; see test/harness/energyplus.ts)
npm run mcp        # the MCP server, over stdio
```

If npm fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, Node is not reading the system trust store.
Point it at the macOS bundle rather than disabling verification:

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
```

**Deployment.** `.github/workflows/pages.yml` typechecks, tests, builds and deploys to GitHub Pages
on every push to `main`.

**MCP.** `npm run mcp` serves 32 tools, including `open_idf`, `new_model`, `find_classes`,
`describe_class`, `add_object`, `rename_object`, `set_simulation_settings`, `inspect_loads`,
`scale_loads`, `add_outputs`, `extrude_zone`, `apply_matches`, `validate`, `save_idf` and `undo`.
Simulation, results and weather are the in-app agent's only. Register it in an MCP client with the command `npx tsx scripts/mcp-server.ts`,
run from the repository root. The tools address objects by name (unnamed singletons such as
`Timestep` by class), return JSON, and share the UI's code and undo history. They are defined once
in `src/mcp/tools.ts` and also serve the in-app agent. Nothing is written to disk until `save_idf`
is called.

## Code layout

| Path | Contents |
|---|---|
| `src/parser/` | Lossless IDF parser and emitter, IDD field table |
| `src/model/` | Building model over the document: names, references, edits, undo history, templates |
| `src/geometry/` | Coordinate resolution, validation, snapping, dragging, creation, matching, tier-3 conversion |
| `src/render/` | three.js scene, viewer and story display |
| `src/simulate/` | Simulation engine and Python REPL (`engine.ts`), its Web Worker (`worker.ts`) and the UI's client (`client.ts`) |
| `src/ui/` | React shell: ribbon (`Ribbon.tsx`, `icons.tsx`), panels including the Python REPL and agent chat, dialogs, examples |
| `src/mcp/` | Tool registry shared with the agent (`tools.ts`), browser-safe session, stdio MCP server |
| `src/schema/` | Full EnergyPlus schema (idfkit): loading, field layout, value checks, validation, class descriptions |
| `src/results/` | Reading `eplusout.sql` (summary, tabular reports, time series, SQL) and the `.rdd`/`.mdd` |
| `src/weather/` | TMYx station search and EPW/DDY download (idfkit) |
| `src/agent/` | In-app agent: providers and settings, tools with approval, system prompt, turn loop |
| `test/` | Unit tests, corpus and round-trip gates, EnergyPlus gates, simulation tests |

## Documents

| Doc | Contents |
|---|---|
| [`docs/01-landscape.md`](docs/01-landscape.md) | Ecosystem survey, the gap, who this is for |
| [`docs/02-prior-art.md`](docs/02-prior-art.md) | Lessons from EPShape, VI-Suite, Pascal Editor, verified at source level |
| [`docs/03-idf-geometry.md`](docs/03-idf-geometry.md) | IDF geometry domain reference: classes, field orders, coordinate rules, gotchas |
| [`docs/04-architecture.md`](docs/04-architecture.md) | System design and the decisions behind it |
| [`docs/05-implementation-plan.md`](docs/05-implementation-plan.md) | Phased build plan, with what each phase measured |

## Stack

TypeScript · Vite · three.js · earcut · polygon-clipping · React (UI chrome only) · Pyodide with
`@luzechao/sim-engine-wasm` for simulation. Entirely client-side, with no backend; the optional
MCP server runs the same library in Node. See [`docs/04-architecture.md`](docs/04-architecture.md)
§Stack for the rationale.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE): parts of the geometry code are transcribed from
EnergyPlus, and the example models are EnergyPlus files; EnergyPlus's BSD-style copyright notice
and conditions travel with them. The simulation engine is a separate package with its own notices.

cartes is an independent project, not affiliated with or endorsed by the U.S. Department of Energy
or the EnergyPlus developers. VI-Suite (GPL v2) was studied as a *reference* only, and no code is
copied from it; see [`docs/02-prior-art.md`](docs/02-prior-art.md) §Licensing.
