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
- **MCP server.** Drive the same operations from an LLM client outside the browser. See
  [MCP and tools](#mcp-and-tools).

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
the same tools as the MCP server, so it gets the same guarantees as the UI: field-level writes,
twins kept in step, proposals before matching. Its tools are listed in
[MCP and tools](#mcp-and-tools).

- **Providers.** OpenAI, Anthropic, or any OpenAI-compatible URL (Ollama, LM Studio, vLLM,
  OpenRouter and similar), through the [Vercel AI SDK](https://ai-sdk.dev). Requests go straight
  from the browser to the provider with your own key; there is no cartes server. Keys stay in
  `sessionStorage` and are forgotten when the tab closes, unless **Remember keys** is checked. A
  local server must allow cross-origin requests from the page (for Ollama, set `OLLAMA_ORIGINS`).
- **Tools.** Model tools read and edit the open model; agent-only tools run Python and
  EnergyPlus, read the last run's results and find weather. Opening, saving and replacing the file
  stay with the user.
- **Edits.** **Ask before edits** (the default) holds each edit until you approve it on its card in
  the chat. A rejected edit is reported back to the agent, which is told not to retry it.
  **Apply automatically** skips the question. Either way, each tool call is one undo step, labelled
  "Agent: …", in the app's own history.
- **Context.** Each turn tells the agent the file, its counts and validation state, the selected
  object, the weather file and the last run.

The AI SDK loads only when the first message is sent, so it adds nothing to the app's initial
download.

## MCP and tools

cartes' model operations are defined once, as a registry of tools in
[`src/mcp/tools.ts`](src/mcp/tools.ts): each is a `ModelSession` method with a zod input schema, a
description written for a language model, and a kind (`read`, `edit` or `destructive`). Two hosts
serve them:

- **The MCP server** (`npm run mcp`, stdio) for any MCP client: Claude Desktop, VS Code, Cursor
  and others. It adds `open_idf` and `save_idf`, which touch the disk.
- **The in-app agent** (the Agent tab) runs them against the document open in the app, asks before
  edits, and adds tools that need the browser's engine.

Either way, objects are addressed by name (unnamed singletons such as `Timestep` by class),
results are JSON, a refused operation returns the reason so the model can correct itself, values
the schema forbids are refused, and every edit is one step in the same undo history the UI uses.
Nothing is written to disk until `save_idf`.

Register the server with an MCP client as a command. For Claude Desktop
(`claude_desktop_config.json`), with the repository set up (`npm install && npm run setup`):

```json
{
  "mcpServers": {
    "cartes": {
      "command": "npx",
      "args": ["tsx", "/path/to/cartes/scripts/mcp-server.ts"]
    }
  }
}
```

| Tool | Kind | MCP | Agent | What it does |
|---|---|:---:|:---:|---|
| **Files** | | | | |
| `open_idf` | read | ✓ | | Open an `.idf` from disk |
| `save_idf` | write | ✓ | | Write the model to an `.idf` |
| `new_model` | destructive | ✓ | | Start a runnable model from the authoring template |
| **Reading** | | | | |
| `summary` | read | ✓ | ✓ | Version, counts, errors and warnings, what undo would undo |
| `check_readiness` | read | ✓ | ✓ | Validation and pre-simulation checks; weather is host-managed |
| `list_objects` | read | ✓ | ✓ | Classes with counts, or the names in one class |
| `inspect` | read | ✓ | ✓ | Every field of one object, with names and units |
| `list_skills`, `get_skill` | read | ✓ | ✓ | Example-learning and simulation-diagnosis procedures |
| `diagnose_energyplus_errors` | read | ✓ | ✓ | Extract severe/fatal messages and suggest tentative offline investigation steps |
| `find_objects` | read | ✓ | ✓ | Find by class pattern or whole-field name, including NodeList users |
| `example_library` | read | ✓ | ✓ | Search engine-version examples and inspect objects and direct dependencies |
| `dataset_library` | read | ✓ | ✓ | Search pinned DataSets; inspect objects or plan bounded recursive dependencies |
| `import_dataset` | edit | ✓ | ✓ | Import a complete, version-compatible DataSet dependency closure as one undoable edit |
| `list_zones` | read | ✓ | ✓ | Zones with floor area and origin |
| `list_surfaces` | read | ✓ | ✓ | Surfaces with type, construction, boundary, area and world vertices |
| `validate` | read | ✓ | ✓ | Geometry checks as EnergyPlus raises them, then field checks over every class |
| `diff` | read | ✓ | ✓ | Unified diff since the file was opened |
| **Schema** | | | | |
| `find_classes` | read | ✓ | ✓ | Search all ~850 EnergyPlus classes by words in name or group |
| `describe_class` | read | ✓ | ✓ | Fields of a class: units, choices, bounds, defaults, references, notes |
| `search_reference` | read | ✓ | ✓ | Search IDD names and notes, with versioned manual links |
| `get_field_reference` | read | ✓ | ✓ | Field constraints and the full IDD note |
| `read_manual_section` | read | ✓ | ✓ | Fetch a paged object section from the online I/O Reference |
| **Editing any class** | | | | |
| `set_field` | edit | ✓ | ✓ | One field, by name or index |
| `update_object` | edit | ✓ | ✓ | Several fields, all or none |
| `add_object` | edit | ✓ | ✓ | A new object, repeating groups included |
| `rename_object` | edit | ✓ | ✓ | Rename and update every reference |
| `duplicate_object` | edit | ✓ | ✓ | Copy under a new name |
| `remove_object` | destructive | ✓ | ✓ | Delete; refused while referenced unless forced |
| **Geometry** | | | | |
| `extrude_zone` | edit | ✓ | ✓ | A zone from a plan outline: walls, floor, roof |
| `add_opening` | edit | ✓ | ✓ | A window or door that fits, mirrored on interzone walls |
| `move_zone` | edit | ✓ | ✓ | Translate a zone; reports pairs it pulls apart |
| `delete_surface` | destructive | ✓ | ✓ | A surface and its openings; twins left or made adiabatic |
| `propose_matches` | read | ✓ | ✓ | Interzone pairings the geometry implies, with exact field changes |
| `apply_matches` | edit | ✓ | ✓ | Apply some or all proposals |
| `convert_simplified` | edit | ✓ | ✓ | Simplified surface classes to explicit vertices |
| **HVAC** | | | | |
| `add_ideal_loads` | edit | ✓ | ✓ | Add idealized constant-setpoint heating and cooling to one unequipped zone |
| `inspect_hvac_topology` | read | ✓ | ✓ | Loop fields, shared-node connections and candidate outlet-to-inlet directions |
| `inspect_loop_structure` | read | ✓ | ✓ | One loop's declared branches and connectors, warnings and Mermaid branch diagram |
| `set_dual_setpoints` | edit | ✓ | ✓ | Set distinct constant heating and cooling schedules together |
| **Settings, loads, outputs** | | | | |
| `get_simulation_settings` | read | ✓ | ✓ | Time step, run periods, SimulationControl, location, design days |
| `set_simulation_settings` | edit | ✓ | ✓ | Time step, a run period's dates, SimulationControl flags |
| `inspect_loads` | read | ✓ | ✓ | People, lights, equipment, infiltration, ventilation, per floor area |
| `scale_loads` | edit | ✓ | ✓ | Multiply the value each object's calculation method uses |
| `inspect_schedule` | read | ✓ | ✓ | Schedule fields and reference graph through other schedules |
| `set_constant_schedule` | edit | ✓ | ✓ | Set a constant schedule within its type limits, acknowledging references |
| `scale_compact_schedule` | edit | ✓ | ✓ | Scale compact schedule values within explicit type limits, acknowledging references |
| `set_hourly_schedule` | edit | ✓ | ✓ | Replace all 24 day-schedule values within type limits, acknowledging references |
| `set_glazing_optics` | edit | ✓ | ✓ | Set supplied effective solar and visible glazing properties |
| `inspect_parameter`, `set_parameter` | read, edit | ✓ | ✓ | Selected glazing, HVAC, water heater, water use and outdoor-air parameters |
| `add_outputs` | edit | ✓ | ✓ | Output variables and meters, skipping duplicates |
| **History** | | | | |
| `undo`, `redo` | edit | ✓ | ✓ | The same history the UI uses |
| **Simulation** | | | | |
| `run_simulation` | run | | ✓ | EnergyPlus 26.1 in the browser, with the Simulate tab's weather and plugins |
| `run_scenarios` | run | | ✓ | Sequential hypothetical scenario runs with locally saved outputs and comparison charts |
| `run_python` | run | | ✓ | Python in the Pyodide interpreter shared with the REPL (`last_run`, `api`) |
| **Results** | | | | |
| `results_summary` | read | | ✓ | Site and source energy, EUI, end uses by fuel, unmet hours |
| `list_report_tables` | read | | ✓ | Tabular reports and their tables |
| `get_report_table` | read | | ✓ | One table as rows × columns with units |
| `list_output_variables` | read | | ✓ | Reported variables and meters, and those the model could request |
| `get_timeseries` | read | | ✓ | Statistics and monthly values of a variable or meter |
| `plot_timeseries` | read | | ✓ | Plot a reported variable or meter's short series or monthly aggregates |
| `query_results` | read | | ✓ | One read-only SELECT against `eplusout.sql` |
| **Weather** | | | | |
| `search_weather` | read | | ✓ | TMYx stations by place, or nearest the model's Site:Location |
| `use_weather` | run | | ✓ | Download a station's EPW and DDY; use the EPW for simulations |
| `apply_design_conditions` | edit | | ✓ | The station's design days and Site:Location into the model |

The host-only kinds: `write` touches the disk; `run` uses the engine or the network and does not
change the model. Some read tools also fetch public reference material. In the agent, `edit` and `destructive` tools wait for approval under
**Ask before edits**; `read` and `run` tools do not.

`example_library` searches an index of the 810 top-level IDF files in EnergyPlus 26.1.0
`testfiles/`, pinned to commit `6f2e40d10250a105b49966baa24d843711e61048`, matching the bundled
engine. Search uses filenames and object types without a network request. Inspecting either of
the two bundled examples works offline; inspecting another downloads that file from GitHub.
These are upstream test models, not necessarily complete runnable templates: some need additional
files. Dependencies shown are direct IDD-declared references. A loaded file whose declared
version differs from the engine is refused; older open models may not be compatible with these
examples. When updating the engine, regenerate the index with `scripts/index-examples.ts` after
updating its pinned version and commit: `npx tsx scripts/index-examples.ts /path/to/testfiles`.
The script verifies every source file against the GitHub tree before indexing it; it requires
`gh` and the extracted pinned `testfiles/` directory.

`dataset_library` searches an offline index of 50 top-level IDFs in the same pinned release's
`datasets/`. Search matches filenames only. Listing classes, retrieving objects or building a
`plan_import` downloads the selected file from GitHub and verifies its size and Git blob hash;
some files are large. The bounded plan follows IDD-declared references within that DataSet and
labels references not found there; it does not edit the open model. `import_dataset` accepts only
a complete plan with no ambiguous references, checks EnergyPlus major/minor compatibility and
resolves external references against the target model before editing. It reuses existing objects
only when class, name, and fields match, refuses conflicting names or definitions, and imports
the accepted objects in one undo step. The in-app agent requests approval first in ask mode.
These are libraries, not necessarily complete or compatible model fragments. Regenerate the filename index
with `npx tsx scripts/index-datasets.ts` after updating its pinned version and commit; it requires `gh`.

`inspect_hvac_topology`
groups model-wide node names and reports candidate outlet-to-inlet connections. These use field
names rather than validated flow paths; ambiguous fields, loop boundaries and branch declarations remain unknown, and
selecting a loop does not filter the components. Duplicate and empty NodeLists are reported and
not expanded. `inspect_loop_structure` instead follows the selected loop's BranchList and
splitter/mixer declarations and reports unresolved references and node mismatches. Its diagram
compares each declared branch-component inlet/outlet with the named object's node fields from the
loaded IDD; components without an inspectable node pair are marked unavailable. These checks are
local consistency checks, not EnergyPlus simulation validation. The diagram is a branch-level
declaration, not a complete loop diagram; air-loop demand equipment is not shown.

Schedule inspection follows declared references. Edits cover constant schedules, bounded compact
schedule scaling and 24-value hourly day schedules. Dual thermostat setpoints can be edited
together only when they use distinct constant schedules. Shared schedules must be explicitly
acknowledged. `set_glazing_optics` accepts supplied effective spectral-average properties; it
does not calculate film or coating properties. Semantic parameters also cover selected
water-heater, water-use and outdoor-air values; outdoor-air rates depend on the configured
calculation method. Other classes must use the general editing tools.

`search_reference` searches bundled IDD text, not the full manuals. `read_manual_section` fetches
the public class and version URL from `docs.idfkit.com`; it requires network access and sends that
URL to the site, but not the model. The section is plain text and may omit formatting. Older models
use the nearest available schema, so check the returned version. If Node reports a certificate
chain error on a managed network, configure Node to trust the appropriate system certificate
store (for example `NODE_USE_SYSTEM_CA=1` on supported Node versions).

Results tools read the last run's `eplusout.sql` with Python's `sqlite3` in the Pyodide
interpreter, aggregating in SQL so that only summaries cross into the page. `run_simulation`
adds `Output:SQLite`, `Output:VariableDictionary` and `Output:Table:SummaryReports` to the text it
simulates when the model lacks them; the model itself is not changed. The Simulate tab's own
**Simulate** runs the model exactly as written.

`run_scenarios` runs 2–6 named copies of the open model sequentially with the same weather and
input files. It supports the advertised semantic parameters and `Schedule:Constant` changes;
include an unchanged baseline, and acknowledge shared schedules. It validates every change before
starting, without editing the open model. The worker queue is reserved through each run and its
summary queries. Each returned outcome, including a failed run, is saved locally in browser IndexedDB
before the next run. In **Simulate → Files → Saved scenarios**, prepare and download a ZIP containing
the actual simulated model, metadata and every returned output file, or download the model and outputs
individually. Preparing a ZIP requires extra memory; ZIPs are limited to 256 MiB. Weather and extra input files
are not included. Saved scenarios survive reloads, worker restarts and subsequent runs, but browser
storage is subject to quota, clearing and eviction; download archives for safekeeping. Delete saved
scenarios there to free space. If saving fails, the batch stops and reports the error, and the
unsaved outcome remains the current run until replaced. Previously saved outcomes remain available.
If a run throws before producing an outcome, it has no files to save. Cancellation waits for the
current run to finish and saves its outcome. Only the last worker run is accessible through results
tools and Python's `last_run`; a saved earlier SQL file can be downloaded but is not queryable there.
The last attempted outcome remains the Simulate tab's current result. A failed run stops the batch,
and missing summaries are reported rather than plotted as zero. Python plugins are not supported
in batches because their interpreter state can persist. Stopping waits for the current run.
Weather-free runs simulate design days only and should not be presented as annual comparisons.
Charts appear in the agent tool card; `plot_timeseries` shows up to 48 reported points or monthly
aggregates, with equally spaced points and no year in individual timestamps.

The tool set learns from two existing EnergyPlus MCP servers, idfkit-mcp and LBNL's
EnergyPlus-MCP; [`docs/02-prior-art.md`](docs/02-prior-art.md) compares them.

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
are accepted for each other. EnergyPlus does the same: its own example files, which run, hold 836
such values across the 164 we validate.

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

**MCP.** `npm run mcp` serves the model tools over stdio; see [MCP and tools](#mcp-and-tools).

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
| [`docs/02-prior-art.md`](docs/02-prior-art.md) | Lessons from EPShape, VI-Suite, Pascal Editor, idfkit, idfkit-mcp, EnergyPlus-MCP, idfkit-shoebox and browser-energy-simulation, verified at source level |
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
