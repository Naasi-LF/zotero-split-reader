/* global Zotero, Services, SplitReader */
// Zotero 插件入口。真正的逻辑在 content/split-reader.js。

var SplitReader;
var SplitReaderSelfTest;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "content/split-reader.js");
  SplitReader.init({ id, version, rootURI });
  for (let win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) SplitReader.onMainWindowLoad(win);
  }

  // 只在开发自测时打开：xpi 里不包含 test/ 目录，也不会设置这个偏好
  if (Zotero.Prefs.get("extensions.splitreader.selftest", true)) {
    Services.scriptloader.loadSubScript(rootURI + "test/selftest.js");
    SplitReaderSelfTest.run(SplitReader);
  }
}

function onMainWindowLoad({ window }) {
  SplitReader?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  SplitReader?.onMainWindowUnload(window);
}

function shutdown() {
  SplitReader?.shutdown();
  SplitReader = undefined;
}
