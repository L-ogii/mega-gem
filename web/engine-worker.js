// MegaGem engine worker.
//
// Boots Pyodide off the main thread, unpacks megagem.zip (the canonical
// research/megagem package + saved_best_weights/, built by web/build.py)
// and drives megagem.browser.BrowserSession. The page talks to it with
// {id, cmd, args} messages and gets {id, ok, result | error} back.
//
// ?pyodide=<url> overrides where the runtime is loaded from (handy for
// offline dev with a local copy of the pyodide npm package).

const params = new URL(self.location.href).searchParams;
const PYODIDE_URL = params.get("pyodide") || "https://cdn.jsdelivr.net/npm/pyodide@0.29.5/";
const BUILD = params.get("v") || "dev";

const PY_GLUE = `
import json, sys
sys.path.insert(0, "/home/pyodide/megagem_site")
from megagem.browser import BrowserSession, AI_KINDS

_session = None

def megagem_call(cmd, args_json):
    global _session
    args = json.loads(args_json)
    if cmd == "new":
        _session = BrowserSession(
            args["seats"],
            chart=args.get("chart", "A"),
            seed=args.get("seed"),
            explain=bool(args.get("explain")),
        )
        return json.dumps(_session.start())
    if _session is None:
        raise RuntimeError("No game in progress.")
    if cmd == "bid":
        return json.dumps(_session.bid(int(args["amount"])))
    if cmd == "reveal":
        return json.dumps(_session.reveal(args["color"]))
    if cmd == "step":
        return json.dumps(_session.step())
    if cmd == "view":
        return json.dumps(_session.view())
    raise ValueError(f"Unknown command: {cmd!r}")
`;

let call = null;

const progress = (stage) => self.postMessage({ type: "progress", stage });

const ready = (async () => {
  progress("Downloading the Python runtime…");
  importScripts(PYODIDE_URL + "pyodide.js");
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  progress("Loading the game engine…");
  const resp = await fetch(`megagem.zip?v=${BUILD}`);
  if (!resp.ok) throw new Error(`megagem.zip: HTTP ${resp.status}`);
  pyodide.unpackArchive(await resp.arrayBuffer(), "zip", {
    extractDir: "/home/pyodide/megagem_site",
  });
  progress("Warming up the bots…");
  pyodide.runPython(PY_GLUE);
  call = pyodide.globals.get("megagem_call");
  self.postMessage({ type: "ready" });
})().catch((err) => {
  self.postMessage({ type: "fatal", error: String(err && err.message || err) });
  throw err;
});

self.onmessage = async (event) => {
  const { id, cmd, args } = event.data;
  try {
    await ready;
    const result = JSON.parse(call(cmd, JSON.stringify(args || {})));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
