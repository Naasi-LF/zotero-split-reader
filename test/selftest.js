/* global Zotero, Services, IOUtils, PathUtils, Components, SplitReaderSelfTest */
// 开发自测，只在一个临时的 Zotero 配置里跑（见 test/run-selftest.sh），不进 xpi。
// 会在临时文献库里新建条目，所以先检查数据目录确实是临时目录，否则什么都不做。
//
// 第 1 阶段：各项功能，最后留下两个带分屏记录的标签（一个新格式、一个 0.1 版旧格式）后退出。
// 第 2 阶段：重启后检查这两个标签的分屏能不能照记录恢复。

SplitReaderSelfTest = {
  async run(SR) {
    const root = Zotero.Prefs.get("extensions.splitreader.selftestRoot", true);
    const phase = Zotero.Prefs.get("extensions.splitreader.selftestPhase", true) || 1;
    const out = PathUtils.join(root, `report${phase}.json`);
    const expectFile = PathUtils.join(root, "expect.json");
    const report = { steps: [], errors: [], loggedErrors: [], consoleErrors: [] };
    const step = (name, ok, info) => report.steps.push({ name, ok: !!ok, info });
    const sleep = (ms) => Zotero.Promise.delay(ms);
    const until = async (fn, ms = 20000) => {
      let start = Date.now();
      while (Date.now() - start < ms) {
        try {
          let v = await fn();
          if (v) return v;
        }
        catch (e) {}
        await sleep(100);
      }
      return null;
    };

    // 记下阅读器、插件和数据库代码里冒出来的 JavaScript 报错（不经过 Zotero.logError 的也算）
    const consoleListener = {
      observe(msg) {
        try {
          let e = msg.QueryInterface(Components.interfaces.nsIScriptError);
          if (/reader\.js|split-reader|selftest|db\.js/.test(e.sourceName || "") && !(e.flags & 1)) {
            report.consoleErrors.push(`${e.sourceName}:${e.lineNumber} ${e.errorMessage}`);
          }
        }
        catch (_) {}
      }
    };
    Services.console.registerListener(consoleListener);
    let origLogError = Zotero.logError;
    Zotero.logError = function (e) {
      report.loggedErrors.push(String(e && (e.stack || e.message) || e));
      return origLogError.apply(this, arguments);
    };

    let win;
    try {
      await Zotero.uiReadyPromise;
      let dataDir = Zotero.DataDirectory.dir;
      if (!root || !dataDir.startsWith(root)) {
        throw new Error(`数据目录 ${dataDir} 不在临时目录 ${root} 下，停止自测`);
      }
      win = await until(() => {
        let w = Zotero.getMainWindow();
        return w && w.ZoteroPane && w.Zotero_Tabs && w.ZoteroPane.itemsView ? w : null;
      });
      await sleep(1500);

      // ---------------------------------------------------------- 工具
      const shot = async (name) => {
        try {
          let snap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
          let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = snap.width;
          canvas.height = snap.height;
          canvas.getContext("2d").drawImage(snap, 0, 0);
          let blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
          await IOUtils.write(PathUtils.join(root, name), new Uint8Array(await blob.arrayBuffer()));
        }
        catch (e) {
          report.errors.push(`截图 ${name} 失败：${e}`);
        }
      };
      const pagesOf = (reader) =>
        reader?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.pagesCount || 0;
      const browsers = (tabID) =>
        [...(win.document.getElementById(tabID)?.querySelectorAll("browser.reader") || [])];
      const readersInTab = (tabID) => Zotero.Reader._readers.filter((r) => r.tabID === tabID);
      const layout = (tabID) => SR._layouts.get(tabID);
      // 布局结构：每列一个数组，主阅读器记作 "main"，其余记附件 ID
      const shape = (tabID) => layout(tabID)?.columns.map((c) => c.cells.map((x) => (x.main ? "main" : x.itemID)));
      const cellOf = (tabID, itemID) => SR._cells(layout(tabID)).find((c) => (itemID === "main" ? c.main : c.itemID === itemID));
      const rectOf = (cell) => cell.reader._iframe.getBoundingClientRect();
      const barOf = (tabID, cell) => layout(tabID).decor.find((el) => el._split.type === "bar" && el._split.cell === cell);
      const allRendered = (tabID) => SR._cells(layout(tabID)).every((c) => pagesOf(c.reader) > 0);
      // 所有格子都在容器里、互不重叠、加起来铺满（扣掉分隔条）
      const geometryOK = (tabID) => {
        let L = layout(tabID);
        let box = L.container.getBoundingClientRect();
        let rects = SR._cells(L).map(rectOf);
        let inside = rects.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1 &&
          r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.width > 20 && r.height > 20);
        let overlap = false;
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            let a = rects[i];
            let b = rects[j];
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlap = true;
          }
        }
        let area = rects.reduce((s, r) => s + r.width * r.height, 0) / (box.width * box.height);
        return { ok: inside && !overlap && area > 0.9, inside, overlap, area: Math.round(area * 1000) / 1000 };
      };
      const openSub = async (menuEl) => {
        let sub = menuEl?.menupopup;
        if (!sub) return null;
        let subShown = new Promise((r) => sub.addEventListener("popupshown", r, { once: true }));
        sub.openPopup(menuEl, "end_before", 0, 0, true);
        await subShown;
        await sleep(300);
        return sub;
      };
      const visible = async (root, l10nID) => {
        let els = root ? [...root.querySelectorAll(`[data-l10n-id="${l10nID}"]`)].filter((e) => !e.hidden) : [];
        if (els.length) await win.document.l10n.translateElements(els);
        return els;
      };
      const openItemMenu = async (itemIDs) => {
        await win.ZoteroPane.selectItems(itemIDs);
        await sleep(400);
        let menu = win.document.getElementById("zotero-itemmenu");
        let shown = new Promise((r) => menu.addEventListener("popupshown", r, { once: true }));
        // 和 ZoteroPane.onItemsContextMenuOpen 一样：先构建菜单再弹出
        await win.ZoteroPane.buildItemContextMenu();
        menu.openPopupAtScreen(200, 200, true);
        await shown;
        await sleep(300);
        return menu;
      };
      const openTabMenu = async (tabID) => {
        let popup = win.Zotero_Tabs._openMenu(300, 30, tabID);
        await new Promise((r) => (popup.state === "open" ? r() : popup.addEventListener("popupshown", r, { once: true })));
        await sleep(300);
        return popup;
      };
      const drag = async (el, from, to) => {
        let PE = win.PointerEvent;
        el.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: from.x, clientY: from.y }));
        let L = SR._layouts.get(el.closest("tab-content")?.id);
        let overlay = L?.overlay;
        overlay?.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: to.x, clientY: to.y }));
        overlay?.dispatchEvent(new PE("pointerup", { bubbles: true, clientX: to.x, clientY: to.y }));
        await sleep(300);
        return overlay;
      };

      if (phase === 2) {
        await this.phase2(SR, win, { step, sleep, until, shape, layout, allRendered, geometryOK, rectOf, cellOf, shot, expectFile });
        throw null;
      }

      // ---------------------------------------------------------- 1. 准备条目
      let pdfs = Zotero.Prefs.get("extensions.splitreader.selftestPDFs", true).split("|");
      let parent = new Zotero.Item("journalArticle");
      parent.setField("title", "Split Reader 自测");
      await parent.saveTx();
      let attA = await Zotero.Attachments.importFromFile({ file: pdfs[0], parentItemID: parent.id });
      let attB = await Zotero.Attachments.importFromFile({ file: pdfs[1], parentItemID: parent.id });
      attB.setField("title", "Zh_译文.pdf");
      await attB.saveTx();
      let extras = [];
      for (let i = 1; i <= 16; i++) {
        let att = await Zotero.Attachments.importFromFile({ file: pdfs[2] });
        att.setField("title", `P${i}`);
        await att.saveTx();
        extras.push(att);
      }

      let together = SR._togetherAttachments([parent]);
      step("选中一个带两份 PDF 的条目：两份都打开，按附件顺序",
        together && together.length === 2 && together[0].id === attA.id && together[1].id === attB.id,
        together && together.map((x) => x.getField("title")));
      step("只选一个附件时不显示“一起分屏打开”", SR._togetherAttachments([attA]) === null);
      step("选中五个条目就是五个", SR._togetherAttachments([attA, ...extras.slice(0, 4)])?.length === 5);
      let grids = [2, 3, 4, 5, 6, 9, 10, 16].map((n) => JSON.stringify(SR._gridFor(n).map((c) => c.length)));
      step("排法：3 个以内并排，更多时接近正方形、最多 4 列",
        JSON.stringify(grids) === JSON.stringify(["[1,1]", "[1,1,1]", "[2,2]", "[2,2,1]", "[2,2,2]", "[3,3,3]", "[3,3,2,2]", "[4,4,4,4]"]),
        grids);
      step("按行填：2×2 时第一行是第 1、2 个", JSON.stringify(SR._gridFor(4)) === "[[0,2],[1,3]]", SR._gridFor(4));

      // 选了 17 个：菜单在，但不能点，并写明上限
      let menu = await openItemMenu([attA.id, attB.id, ...extras.slice(0, 15).map((x) => x.id)]);
      let overEl = (await visible(menu, "split-reader-open"))[0];
      step("选了 17 个时“一起分屏打开”不能点，并写明最多 16 个",
        overEl && overEl.disabled && overEl.getAttribute("label").includes("16"), overEl?.getAttribute("label"));
      menu.hidePopup();

      // ---------------------------------------------------------- 2. 一起分屏打开（原文 + 译文）
      menu = await openItemMenu([parent.id]);
      let openEl = (await visible(menu, "split-reader-open"))[0];
      step("条目右键菜单里有“一起分屏打开（2 个）”", openEl && openEl.getAttribute("label").includes("2"),
        openEl?.getAttribute("label"));
      openEl?.doCommand();
      menu.hidePopup();
      let tabID = await until(() => {
        let id = win.Zotero_Tabs.getTabIDByItemID(attA.id);
        return id && layout(id) && SR._cells(layout(id)).length === 2 ? id : null;
      });
      await until(() => allRendered(tabID));
      await sleep(800);
      step("点了之后新开一个标签，两列：主阅读器和译文",
        JSON.stringify(shape(tabID)) === JSON.stringify([["main"], [attB.id]]), shape(tabID));
      let rA = rectOf(cellOf(tabID, "main"));
      let rB = rectOf(cellOf(tabID, attB.id));
      step("左右并排、宽度接近、都渲染出了页面",
        rA.right <= rB.left + 1 && Math.abs(rA.width - rB.width) < 4 && allRendered(tabID),
        { a: [rA.left, rA.width], b: [rB.left, rB.width] });
      step("getByTabID 仍然返回主阅读器（Zotero 自己的逻辑不受影响）",
        Zotero.Reader.getByTabID(tabID)?.itemID === attA.id);
      step("标签数据里记下了新格式的布局", win.Zotero_Tabs._getTab(tabID).tab.data.splitReader?.v === 2);
      await shot("1-two-columns.png");

      // ---------------------------------------------------------- 3. 每格的小工具条
      let mainCell = cellOf(tabID, "main");
      let mainBar = barOf(tabID, mainCell);
      let bBar = barOf(tabID, cellOf(tabID, attB.id));
      step("每格都有小工具条，主阅读器那格没有关闭按钮",
        mainBar && bBar && !mainBar.querySelector(".split-reader-close") && bBar.querySelector(".split-reader-close"));
      step("主阅读器在最左列且这列只有它：← 不能点，→ 能点",
        mainBar.querySelector(".split-reader-left").disabled && !mainBar.querySelector(".split-reader-right").disabled);

      // → 把主阅读器移到右边那列底下：变成一列上下两格
      mainBar.querySelector(".split-reader-right").click();
      await sleep(400);
      rA = rectOf(cellOf(tabID, "main"));
      rB = rectOf(cellOf(tabID, attB.id));
      step("点 → 后主阅读器移到右边那列底下（上下两格）",
        JSON.stringify(shape(tabID)) === JSON.stringify([[attB.id, "main"]]) &&
        Math.abs(rA.left - rB.left) < 1 && rB.bottom <= rA.top + 1, shape(tabID));
      await shot("2-stacked.png");
      barOf(tabID, cellOf(tabID, "main")).querySelector(".split-reader-up").click();
      await sleep(300);
      step("点 ↑ 后和上面那格对调", JSON.stringify(shape(tabID)) === JSON.stringify([["main", attB.id]]), shape(tabID));
      barOf(tabID, cellOf(tabID, attB.id)).querySelector(".split-reader-right").click();
      await sleep(300);
      step("在最右列点 →（这列不止一格）会新开一列", JSON.stringify(shape(tabID)) === JSON.stringify([["main"], [attB.id]]), shape(tabID));

      // ---------------------------------------------------------- 4. 开满 4×4
      for (let i = 0; i < 2; i++) await SR.addPane(win, tabID, extras[i].id);
      let widths = SR._cells(layout(tabID)).map((c) => Math.round(rectOf(c).width));
      // 边上两列只扣半条分隔条，中间的两边各扣半条，所以允许差一条分隔条的宽度
      step("加到 4 列，宽度一样", layout(tabID).columns.length === 4 &&
        Math.max(...widths) - Math.min(...widths) <= 6, widths);
      for (let i = 2; i < 14; i++) await SR.addPane(win, tabID, extras[i].id);
      await until(() => allRendered(tabID), 60000);
      await sleep(1000);
      let g = geometryOK(tabID);
      step("开满 16 格：4 列、每列 4 个，全部渲染，互不重叠、铺满",
        SR._cells(layout(tabID)).length === 16 && layout(tabID).columns.every((c) => c.cells.length === 4) &&
        allRendered(tabID) && g.ok && browsers(tabID).length === 16 && readersInTab(tabID).length === 16, g);
      await shot("3-grid-4x4.png");
      let full = await SR.addPane(win, tabID, extras[14].id);
      step("第 17 格加不进去", full === "full" && SR._cells(layout(tabID)).length === 16, full);
      let menuFull = await openItemMenu([extras[14].id]);
      let openInFull = (await visible(menuFull, "split-reader-open-in-tab"))[0];
      let fullSub = await openSub(openInFull);
      let fullTarget = (await visible(fullSub, "split-reader-target-tab")).find((e) => e._splitReaderEntry?.tabID === tabID);
      step("放满的标签在“分屏打开到”里标“已满”、不能点",
        fullTarget && fullTarget.disabled && fullTarget.getAttribute("label").includes("已满"),
        fullTarget?.getAttribute("label"));
      fullSub?.hidePopup();
      menuFull.hidePopup();

      // ---------------------------------------------------------- 5. 拖分隔条
      let L = layout(tabID);
      let box = L.container.getBoundingClientRect();
      let colSplit = L.decor.find((el) => el._split.type === "col" && el._split.ci === 1);
      let midY = box.top + box.height / 2;
      let ov = await drag(colSplit, { x: box.left + box.width * 0.25, y: midY }, { x: box.left + box.width * 0.4, y: midY });
      let c0 = rectOf(L.columns[0].cells[0]);
      step("拖第一条竖分隔条到 40%：第一列变宽、第二列变窄、遮罩收掉",
        ov && !ov.isConnected && Math.abs(L.columns[0].w - 0.4) < 0.01 && Math.abs(L.columns[1].w - 0.1) < 0.01 &&
        Math.abs((c0.right - box.left) / box.width - 0.4) < 0.02, { w: L.columns.map((c) => c.w) });
      let rowSplit = L.decor.find((el) => el._split.type === "row" && el._split.ci === 0 && el._split.ri === 1);
      await drag(rowSplit, { x: box.left + 10, y: box.top + box.height * 0.25 }, { x: box.left + 10, y: box.top + box.height * 0.1 });
      step("拖第一列的横分隔条：上面那格变矮",
        Math.abs(L.columns[0].cells[0].h - 0.1) < 0.01 && Math.abs(L.columns[0].cells[1].h - 0.4) < 0.01,
        L.columns[0].cells.map((c) => c.h));
      step("拖动后布局仍然互不重叠、铺满", geometryOK(tabID).ok, geometryOK(tabID));
      colSplit.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      L.decor.find((el) => el._split.type === "row" && el._split.ci === 0 && el._split.ri === 1)
        .dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      await sleep(200);
      step("双击分隔条恢复等分", L.columns.every((c) => Math.abs(c.w - 0.25) < 1e-6) &&
        L.columns[0].cells.every((c) => Math.abs(c.h - 0.25) < 1e-6));

      // ---------------------------------------------------------- 6. 关一格、回收站
      let victim = cellOf(tabID, extras[13].id);
      let victimCol = L.columns[SR._locate(L, victim)[0]];
      let victimBrowser = victim.reader._iframe;
      barOf(tabID, victim).querySelector(".split-reader-close").click();
      await until(() => SR._cells(layout(tabID)).length === 15);
      step("点 × 关掉一格：阅读器和页面元素都清掉，那一列剩下的重新等分",
        SR._cells(layout(tabID)).length === 15 && !victimBrowser.isConnected &&
        readersInTab(tabID).length === 15 && victimCol.cells.every((c) => Math.abs(c.h - 1 / 3) < 1e-6));
      extras[12].deleted = true;
      await extras[12].saveTx();
      await until(() => !cellOf(tabID, extras[12].id));
      await sleep(500);
      step("附件被移进回收站时只关它那一格，标签还在",
        !!win.Zotero_Tabs._getTab(tabID)?.tab && SR._cells(layout(tabID)).length === 14 && readersInTab(tabID).length === 14);

      // ---------------------------------------------------------- 7. 关闭所有分屏（标签菜单）
      let popup = await openTabMenu(tabID);
      let closeAllEl = (await visible(popup, "split-reader-close-right"))[0];
      step("标签右键有“关闭所有分屏”", !!closeAllEl, closeAllEl?.getAttribute("label"));
      closeAllEl?.doCommand();
      popup.hidePopup();
      await until(() => !layout(tabID));
      await sleep(300);
      step("关闭所有分屏后只剩主阅读器、记录清掉、覆盖层清掉",
        !layout(tabID) && browsers(tabID).length === 1 && readersInTab(tabID).length === 1 &&
        !win.Zotero_Tabs._getTab(tabID).tab.data.splitReader &&
        !win.document.querySelector(".split-reader-splitter, .split-reader-cellbar"));

      // ---------------------------------------------------------- 8. 三个添加入口
      // (a) 标签右键 → 添加分屏 → 已打开的标签
      let otherReader = await Zotero.Reader.open(extras[0].id);
      await otherReader._initPromise;
      let otherTabID = otherReader.tabID;
      popup = await openTabMenu(tabID);
      let addEl = (await visible(popup, "split-reader-show-right"))[0];
      let sub = await openSub(addEl);
      let cands = await visible(sub, "split-reader-candidate");
      let pickEl = (await visible(sub, "split-reader-pick-from-library"))[0];
      step("“添加分屏”子菜单：同条目的译文、已打开的标签、从文库中选择…",
        cands.some((e) => e._splitReaderEntry?.kind === "sibling") && cands.some((e) => e._splitReaderEntry?.kind === "tab") && !!pickEl,
        cands.map((e) => e.getAttribute("label")));
      cands.find((e) => e._splitReaderEntry?.kind === "tab")?.doCommand();
      sub?.hidePopup();
      popup.hidePopup();
      await until(() => cellOf(tabID, extras[0].id)?.reader?._iframe);
      await sleep(800);
      step("从已打开的标签挑：它并进来、原标签关掉",
        !!cellOf(tabID, extras[0].id) && !win.Zotero_Tabs._getTab(otherTabID)?.tab);

      // (b) 文库右键 → 分屏打开到 → 这个标签
      menu = await openItemMenu([extras[1].id]);
      let openInEl = (await visible(menu, "split-reader-open-in-tab"))[0];
      let targetSub = await openSub(openInEl);
      let target = (await visible(targetSub, "split-reader-target-tab")).find((e) => e._splitReaderEntry?.tabID === tabID);
      step("只选一个附件时，文库右键有“分屏打开到”，子菜单列出这个标签",
        !!openInEl && !!target && target.getAttribute("label").includes(win.Zotero_Tabs._getTab(tabID).tab.title),
        target?.getAttribute("label"));
      target?.doCommand();
      targetSub?.hidePopup();
      menu.hidePopup();
      await until(() => cellOf(tabID, extras[1].id));
      await sleep(500);
      step("点了之后加进这个标签并切过去",
        !!cellOf(tabID, extras[1].id) && win.Zotero_Tabs.selectedID === tabID);

      // (c) 标签右键 → 添加分屏 → 从文库中选择…
      let picking = SR.pickFromLibrary(win, tabID);
      let dlg = await until(() => {
        for (let w of Services.wm.getEnumerator(null)) {
          if (w.location.href.includes("selectItemsDialog") && w.itemsView && w.itemsView.rowCount > 0) return w;
        }
        return null;
      });
      step("“从文库中选择…”弹出了条目选择框", !!dlg);
      if (dlg) {
        await dlg.itemsView.selectItem(extras[2].id);
        await sleep(300);
        dlg.document.querySelector("dialog").acceptDialog();
      }
      await picking;
      await until(() => cellOf(tabID, extras[2].id));
      await until(() => allRendered(tabID));
      await sleep(800);
      step("在选择框里选中的条目加进来了", !!cellOf(tabID, extras[2].id) && layout(tabID).columns.length === 4,
        shape(tabID));
      await shot("4-four-columns.png");

      // ---------------------------------------------------------- 9. 卸载后恢复（含上下分格）
      SR.moveCell(tabID, cellOf(tabID, extras[2].id), "left");
      SR.moveCell(tabID, cellOf(tabID, extras[1].id), "up");
      await sleep(300);
      let before = JSON.stringify(shape(tabID));
      win.Zotero_Tabs.select("zotero-pane");
      await sleep(300);
      win.Zotero_Tabs.unload(tabID);
      await sleep(500);
      step("卸载标签时所有格子被清理", !layout(tabID) && readersInTab(tabID).length === 0);
      win.Zotero_Tabs.select(tabID);
      await until(() => layout(tabID) && SR._cells(layout(tabID)).length === 4);
      await until(() => allRendered(tabID));
      await sleep(500);
      step("重新加载后布局照原样恢复（包括上下分格）",
        JSON.stringify(shape(tabID)) === before && geometryOK(tabID).ok, { before, after: shape(tabID) });

      // ---------------------------------------------------------- 10. 关标签
      let readersBefore = Zotero.Reader._readers.length;
      win.Zotero_Tabs.close(tabID);
      await sleep(800);
      step("关闭标签后所有阅读器都被清理",
        !layout(tabID) && readersInTab(tabID).length === 0 && Zotero.Reader._readers.length === readersBefore - 4,
        { before: readersBefore, after: Zotero.Reader._readers.length });

      // ---------------------------------------------------------- 10b. 一起分屏打开 6 个：3 列、每列 2 个、按行填
      let six = extras.slice(3, 9);
      menu = await openItemMenu(six.map((x) => x.id));
      openEl = (await visible(menu, "split-reader-open"))[0];
      openEl?.doCommand();
      menu.hidePopup();
      let tab6 = await until(() => {
        let id = win.Zotero_Tabs.getTabIDByItemID(six[0].id);
        return id && layout(id) && SR._cells(layout(id)).length === 6 ? id : null;
      });
      await until(() => tab6 && allRendered(tab6), 30000);
      await sleep(800);
      let want6 = [["main", six[3].id], [six[1].id, six[4].id], [six[2].id, six[5].id]];
      step("一起分屏打开 6 个：新标签、3 列每列 2 个、按行从左到右填、全部渲染",
        !!tab6 && JSON.stringify(shape(tab6)) === JSON.stringify(want6) && allRendered(tab6) && geometryOK(tab6).ok,
        tab6 && shape(tab6));
      await shot("5-together-six.png");
      if (tab6) win.Zotero_Tabs.close(tab6);
      await sleep(800);

      // ---------------------------------------------------------- 11. 给第 2 阶段留下两个标签
      // (a) 新格式：3 列，中间一列上下两格，宽度不等
      let tab2 = await SR.openTogether(win, [attA, attB]);
      await SR.addPane(win, tab2, extras[3].id);
      await SR.addPane(win, tab2, extras[4].id);
      SR.moveCell(tab2, cellOf(tab2, extras[4].id), "left");
      layout(tab2).columns[0].w = 0.5;
      layout(tab2).columns[1].w = 0.3;
      layout(tab2).columns[2].w = 0.2;
      SR._position(layout(tab2));
      SR._save(layout(tab2));
      // (b) 0.1 版的旧格式记录：右边是 P6，左右互换过，比例 0.3
      let oldReader = await Zotero.Reader.open(extras[5 + 1].id);
      await oldReader._initPromise;
      win.Zotero_Tabs.setTabData(oldReader.tabID, { splitReader: { itemID: extras[5].id, ratio: 0.3, swapped: true } });
      win.Zotero_Tabs.select(tab2);
      await IOUtils.writeUTF8(expectFile, JSON.stringify({
        newShape: shape(tab2),
        newWidths: [0.5, 0.3, 0.2],
        oldTabMain: extras[6].id,
        oldRight: extras[5].id
      }));
      await Zotero.Session.save();

      // ---------------------------------------------------------- 12. 插件关闭时收干净
      SR.shutdown();
      await sleep(300);
      step("插件关闭时收掉分屏、覆盖层、菜单文字，但保留记录",
        SR._layouts.size === 0 && browsers(tab2).length === 1 &&
        !win.document.querySelector(".split-reader-splitter, .split-reader-cellbar, link[href='split-reader.ftl']") &&
        win.Zotero_Tabs._getTab(tab2).tab.data.splitReader?.v === 2);
      await Zotero.Session.save();
    }
    catch (e) {
      // throw null 只是第二阶段提前结束
      if (e !== null) report.errors.push(String(e) + "\n" + (e.stack || ""));
    }
    finally {
      Zotero.logError = origLogError;
    }
    await sleep(1000);
    Services.console.unregisterListener(consoleListener);
    // Zotero 自己的竞态：SyncedSettings.loadAll 先清空缓存再异步读回，
    // 期间另一个阅读器保存页码就会重复 INSERT。不是插件的错误，单独记下次数
    const knownRace = /UNIQUE constraint failed: syncedSettings.*lastPageIndex_/;
    report.knownZoteroRace = report.consoleErrors.filter((e) => knownRace.test(e)).length;
    let realErrors = report.consoleErrors.filter((e) => !knownRace.test(e));
    step("整个过程中阅读器和插件代码没有报 JavaScript 错误", realErrors.length === 0, realErrors.slice(0, 10));

    report.passed = report.steps.filter((s) => s.ok).length;
    report.total = report.steps.length;
    await IOUtils.writeUTF8(out, JSON.stringify(report, null, 2));
    if (Zotero.Prefs.get("extensions.splitreader.selftestQuit", true)) {
      Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
    }
  },

  async phase2(SR, win, t) {
    let { step, sleep, until, shape, layout, allRendered, geometryOK, shot, expectFile } = t;
    let expect = JSON.parse(await IOUtils.readUTF8(expectFile));

    let newTab = win.Zotero_Tabs._tabs.find((x) => x.data?.splitReader?.v === 2);
    step("重启后会话里还留着新格式的布局记录", !!newTab);
    if (newTab) {
      win.Zotero_Tabs.select(newTab.id);
      await until(() => layout(newTab.id) && SR._cells(layout(newTab.id)).length === 4);
      await until(() => allRendered(newTab.id));
      await sleep(1000);
      let widths = layout(newTab.id)?.columns.map((c) => Math.round(c.w * 100) / 100);
      step("重启后照记录恢复：3 列、中间一列上下两格、宽度 50/30/20",
        JSON.stringify(shape(newTab.id)) === JSON.stringify(expect.newShape) &&
        JSON.stringify(widths) === JSON.stringify(expect.newWidths) && geometryOK(newTab.id).ok,
        { shape: shape(newTab.id), widths });
      await shot("6-after-restart.png");
    }

    let oldTab = win.Zotero_Tabs._tabs.find((x) => x.data?.itemID === expect.oldTabMain);
    step("0.1 版旧格式的记录还在", !!oldTab?.data?.splitReader?.itemID);
    if (oldTab) {
      win.Zotero_Tabs.select(oldTab.id);
      await until(() => layout(oldTab.id) && SR._cells(layout(oldTab.id)).length === 2);
      await until(() => allRendered(oldTab.id));
      await sleep(500);
      let L = layout(oldTab.id);
      step("旧格式自动转成两列：互换过的右侧在左边，宽度 0.3/0.7，并改存成新格式",
        JSON.stringify(shape(oldTab.id)) === JSON.stringify([[expect.oldRight], ["main"]]) &&
        Math.abs(L.columns[0].w - 0.3) < 1e-6 && oldTab.data.splitReader?.v === 2,
        { shape: shape(oldTab.id), w: L?.columns.map((c) => c.w), data: oldTab.data.splitReader });
    }
  }
};
