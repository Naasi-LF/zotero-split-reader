/* global Zotero, Services */
// 分屏阅读：在一个阅读标签里摆最多 4 列、每列最多 4 个完整的阅读器。
//
// 做法（基于 Zotero 10.0.8 的 chrome/content/zotero/xpcom/reader.js）：
// ReaderTab 的构造函数在传入已存在的 tabID 时，会把新的 <browser> 追加到那个标签的
// 容器里。我们借这一点，用标签原有阅读器（下文叫“主阅读器”）的同一个类，在同一个标签里
// 再构造若干个阅读器，并登记进 Zotero.Reader._readers，这样批注同步、主题、状态保存都照常工作。
//
// 布局：<browser> 一旦在 DOM 里换了父节点，里面的阅读器页面就会被销毁重建，所以所有阅读器都
// 留在标签容器里不动，用绝对定位摆成网格；分隔条和每格的小工具条也是绝对定位的覆盖层。
//
// Zotero 自己只会清理每个标签的第一个阅读器，其余的（关标签、卸载标签）由我们清理。
// 布局记在标签数据 tab.data.splitReader 里，标签被卸载后重新加载、或者重启 Zotero
// 恢复会话时，据此重新搭起来。

const HTML_NS = "http://www.w3.org/1999/xhtml";
const FTL = "split-reader.ftl";
const MAX_COLUMNS = 4;
const MAX_ROWS = 4;
const MAX_SLOTS = 8;
const GAP = 6; // 分隔条的宽度（px）
const MIN_FRACTION = 0.08; // 拖分隔条时每格最少占的比例
// 摆放时设置过的样式，拆掉布局时要清掉
const POSITION_PROPS = ["position", "left", "top", "width", "height", "margin", "min-width", "min-height", "z-index"];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (frac, px = 0) => {
  let p = `${(frac * 100).toFixed(4)}%`;
  return px ? `calc(${p} ${px > 0 ? "+" : "-"} ${Math.abs(px)}px)` : p;
};

SplitReader = {
  id: null,
  rootURI: null,
  _menuIDs: [],
  _notifierID: null,
  // tabID -> 布局 L：
  // { tabID, win, container, readerA, prevStyle, columns: [{ w, cells: [cell] }], decor: [], overlay }
  // cell: { main, itemID, reader, h }。w、h 是比例，同一层加起来为 1
  _layouts: new Map(),
  _queues: new Map(),

  init({ id, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this._registerMenus();
    this._notifierID = Zotero.Notifier.registerObserver(this, ["tab"], "split-reader");
    // 已经打开、带着分屏记录的标签（比如插件是在 Zotero 运行中装上或重新启用的）
    for (let win of Zotero.getMainWindows()) {
      this._restoreAll(win);
    }
  },

  onMainWindowLoad(win) {
    win.MozXULElement.insertFTLIfNeeded(FTL);
    // 会话恢复出来的阅读标签，可能在插件启动前就已经加载完了
    win.setTimeout(() => this._restoreAll(win), 1000);
  },

  onMainWindowUnload(win) {
    for (let L of [...this._layouts.values()]) {
      if (L.win === win) this._teardown(L.tabID, { clearData: false });
    }
    win.document.querySelector(`link[href="${FTL}"]`)?.remove();
  },

  shutdown() {
    for (let tabID of [...this._layouts.keys()]) {
      this._teardown(tabID, { clearData: false });
    }
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }
    for (let menuID of this._menuIDs) {
      Zotero.MenuManager.unregisterMenu(menuID);
    }
    this._menuIDs = [];
    for (let win of Zotero.getMainWindows()) {
      win.document.querySelector(`link[href="${FTL}"]`)?.remove();
    }
  },

  // ================================================================ 附件挑选

  _readableAttachments(item) {
    if (!item) return [];
    if (item.isAttachment()) {
      return item.attachmentReaderType && !item.deleted ? [item] : [];
    }
    if (!item.isRegularItem()) return [];
    let atts = item.getAttachments()
      .map((id) => Zotero.Items.get(id))
      .filter((att) => att && att.attachmentReaderType && !att.deleted);
    // PDF 排前面，其余保持 Zotero 的顺序
    let rank = (att) => (att.attachmentReaderType === "pdf" ? 0 : 1);
    return atts.map((att, i) => ({ att, i }))
      .sort((x, y) => rank(x.att) - rank(y.att) || x.i - y.i)
      .map((x) => x.att);
  },

  /**
   * “一起分屏打开”要打开的附件：
   * - 选中一个普通条目：它下面所有可读附件（比如原文和译文）
   * - 选中多个条目：每个取一个可读附件（PDF 优先）
   * 按条目列表里的顺序，去重。少于两个返回 null；可能超过 16 个，由调用方处理。
   */
  _togetherAttachments(items) {
    items = (items || []).filter(Boolean);
    let atts = items.length === 1
      ? (items[0].isRegularItem() ? this._readableAttachments(items[0]) : [])
      : items.map((item) => this._readableAttachments(item)[0]).filter(Boolean);
    let seen = new Set();
    atts = atts.filter((att) => !seen.has(att.id) && seen.add(att.id));
    return atts.length >= 2 ? atts : null;
  },

  /**
   * n 个附件怎么排：3 个以内并排成 n 列；更多时排成接近正方形的网格（最多 4 列），
   * 多出来的格子从左边的列开始多放一行。按行填：第一行从左到右，再第二行……
   * 返回 columns，每列是附件下标的数组。
   */
  _gridFor(n) {
    let cols = n <= 3 ? n : Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(n)));
    let base = Math.floor(n / cols);
    let extra = n % cols;
    let rows = Array.from({ length: cols }, (_, c) => base + (c < extra ? 1 : 0));
    let columns = rows.map(() => []);
    let i = 0;
    for (let r = 0; i < n; r++) {
      for (let c = 0; c < cols && i < n; c++) {
        if (r < rows[c]) columns[c].push(i++);
      }
    }
    return columns;
  },

  /** 只选中一个条目时，它对应的可读附件（普通条目取第一个，PDF 优先）。 */
  _singleAttachment(items) {
    items = (items || []).filter(Boolean);
    if (items.length !== 1) return null;
    return this._readableAttachments(items[0])[0] || null;
  },

  /** 标签里现在（或记录里）有哪些附件、一共几格。没分屏的标签只算主阅读器那一格。 */
  _tabContents(win, tabID) {
    let L = this._layouts.get(tabID);
    if (L) {
      let cells = this._cells(L);
      return { itemIDs: new Set(cells.map((c) => c.itemID)), count: cells.length, layout: L };
    }
    let tab = win.Zotero_Tabs._getTab(tabID)?.tab;
    let itemIDs = new Set();
    if (tab?.data?.itemID) itemIDs.add(tab.data.itemID);
    let spec = this._specFromData(tab?.data?.splitReader);
    for (let col of spec?.columns || []) {
      for (let cell of col.cells) if (cell.itemID) itemIDs.add(cell.itemID);
    }
    return { itemIDs, count: Math.max(1, itemIDs.size), layout: null };
  },

  /** “添加分屏”的快捷候选：同一条目下的其他附件，以及其他已打开的阅读标签。 */
  _candidates(win, tabID) {
    let tab = win.Zotero_Tabs._getTab(tabID)?.tab;
    let item = tab && Zotero.Items.get(tab.data?.itemID);
    if (!item) return [];
    let seen = new Set(this._tabContents(win, tabID).itemIDs);
    let out = [];
    if (item.parentItem) {
      for (let att of this._readableAttachments(item.parentItem)) {
        if (seen.has(att.id)) continue;
        seen.add(att.id);
        let title = att.getField("title") || att.attachmentFilename || "";
        out.push({ kind: "sibling", itemID: att.id, l10nArgs: { kind: "sibling", title } });
      }
    }
    for (let other of win.Zotero_Tabs._tabs) {
      let otherItemID = other.data?.itemID;
      if (other.id === tabID || !other.type.startsWith("reader") || !otherItemID || seen.has(otherItemID)) {
        continue;
      }
      seen.add(otherItemID);
      out.push({
        kind: "tab",
        itemID: otherItemID,
        tabID: other.id,
        l10nArgs: { kind: "tab", title: other.title || "" }
      });
    }
    return out.slice(0, MAX_SLOTS);
  },

  /** 可以把 att 放进去的阅读标签：所有打开的阅读标签，除了里面已经有它的。放满的标签也列出来，但不能点。 */
  _targetTabs(win, att) {
    let out = [];
    for (let tab of win.Zotero_Tabs._tabs) {
      if (!tab.type.startsWith("reader") || !tab.data?.itemID) continue;
      let { itemIDs, count } = this._tabContents(win, tab.id);
      if (itemIDs.has(att.id)) continue;
      let full = count >= MAX_COLUMNS * MAX_ROWS;
      out.push({ tabID: tab.id, att, disabled: full, l10nArgs: { title: tab.title || "", full: full ? "yes" : "no" } });
    }
    return out.slice(0, MAX_SLOTS);
  },

  // ================================================================ 对外的操作

  async _checkFile(win, att) {
    if (att && (await att.fileExists())) return true;
    let msg = await win.document.l10n.formatValue("split-reader-file-missing", {
      title: att ? att.getField("title") || att.attachmentFilename || "" : ""
    });
    Services.prompt.alert(win, "Split Reader", msg);
    return false;
  },

  async _alertFull(win) {
    let msg = await win.document.l10n.formatValue("split-reader-full", { columns: MAX_COLUMNS, rows: MAX_ROWS });
    Services.prompt.alert(win, "Split Reader", msg);
  },

  /** 同一个附件不在两个格子里同时打开：把它从别的标签的分屏里拿掉。 */
  async _removeElsewhere(itemID, exceptTabID) {
    for (let L of [...this._layouts.values()]) {
      if (L.tabID === exceptTabID) continue;
      let cell = this._cells(L).find((c) => !c.main && c.itemID === itemID);
      if (cell) await this.removeCell(L.tabID, cell);
    }
  },

  /**
   * 一起分屏打开：第一个附件当主阅读器，其余按 _gridFor 摆好。
   * 第一个附件已经有自己的标签、而且那个标签没分屏时，就用那个标签；否则新开一个。
   */
  async openTogether(win, atts) {
    atts = atts.slice(0, MAX_COLUMNS * MAX_ROWS);
    for (let att of atts) {
      if (!(await this._checkFile(win, att))) return null;
    }
    let [first, ...rest] = atts;
    let existing = win.Zotero_Tabs.getTabIDByItemID(first.id);
    let reuse = existing && !this._layouts.has(existing) && !win.Zotero_Tabs._getTab(existing).tab.data?.splitReader;
    for (let att of atts) await this._removeElsewhere(att.id, reuse ? existing : undefined);
    let tabID;
    if (reuse) {
      win.Zotero_Tabs.select(existing);
      tabID = existing;
    }
    else {
      let reader = await Zotero.Reader.open(first.id, null, { allowDuplicate: !!existing });
      tabID = reader?.tabID || win.Zotero_Tabs.getTabIDByItemID(first.id);
    }
    if (!tabID) throw new Error("Split Reader: 打开第一个附件后找不到它的标签");
    // 先把布局写进标签数据，再按记录一次搭好
    let grid = this._gridFor(atts.length);
    win.Zotero_Tabs.setTabData(tabID, {
      splitReader: {
        v: 2,
        columns: grid.map((col) => ({
          w: 1 / grid.length,
          cells: col.map((i) => (i === 0 ? { main: true, h: 1 / col.length } : { itemID: atts[i].id, h: 1 / col.length }))
        }))
      }
    });
    let L = await this._enqueue(tabID, () => this._ensureLayout(win, tabID));
    await Promise.all(this._cells(L).map((c) => c.reader._initPromise));
    return tabID;
  },

  /** 把附件 att 加进标签 tabID 的分屏，并切到这个标签。 */
  async openInTab(win, tabID, att) {
    if (!(await this._checkFile(win, att))) return;
    await this._removeElsewhere(att.id, tabID);
    let loaded = win.Zotero_Tabs._getTab(tabID)?.tab?.type === "reader";
    // 已加载的标签：先加好再切过去。切标签会让主阅读器保存阅读位置，而新阅读器打开时
    // Zotero 会重载同步设置缓存，两件事撞在一起会触发 Zotero 自己的重复插入报错。
    // 没加载的标签得先切过去，它才会加载出主阅读器。
    if (!loaded) win.Zotero_Tabs.select(tabID);
    let result = await this.addPane(win, tabID, att.id);
    win.Zotero_Tabs.select(tabID);
    if (result === "full") await this._alertFull(win);
  },

  /** 弹出 Zotero 自带的条目选择框，选中的条目加进标签 tabID 的分屏。 */
  async pickFromLibrary(win, tabID) {
    let io = {
      dataIn: null,
      dataOut: null,
      singleSelection: true,
      itemTreeID: "split-reader-select-item",
      hideCollections: ["duplicates", "trash", "feeds", "retracted"],
      deferred: Zotero.Promise.defer()
    };
    win.openDialog("chrome://zotero/content/selectItemsDialog.xhtml", "",
      "chrome,dialog=no,centerscreen,resizable=yes", io);
    await io.deferred.promise;
    let itemID = io.dataOut?.[0];
    if (!itemID) return;
    let att = this._readableAttachments(Zotero.Items.get(itemID))[0];
    if (!att) {
      let msg = await win.document.l10n.formatValue("split-reader-no-attachment");
      Services.prompt.alert(win, "Split Reader", msg);
      return;
    }
    await this.openInTab(win, tabID, att);
  },

  /**
   * 往标签里加一格：列数没满就在最右边新开一列，满了就放进格子最少的那一列底下。
   * 返回 "ok" | "full" | "exists" | "invalid"。
   */
  addPane(win, tabID, itemID) {
    return this._enqueue(tabID, async () => {
      let item = Zotero.Items.get(itemID);
      if (!item?.attachmentReaderType) return "invalid";
      let L = await this._ensureLayout(win, tabID);
      if (this._cells(L).some((c) => c.itemID === itemID)) return "exists";
      let col;
      if (L.columns.length < MAX_COLUMNS) {
        col = { w: 0, cells: [] };
        L.columns.push(col);
        this._equalizeColumns(L);
      }
      else {
        let open = L.columns.filter((c) => c.cells.length < MAX_ROWS);
        if (!open.length) return "full";
        col = open.reduce((a, b) => (b.cells.length < a.cells.length ? b : a));
      }
      let cell = { main: false, itemID, reader: this._createReader(win, tabID, L.readerA, item), h: 0 };
      col.cells.push(cell);
      this._equalizeRows(col);
      this._render(L);
      this._save(L);
      await cell.reader._initPromise;
      return "ok";
    });
  },

  /** 关掉一格（主阅读器那一格不能关）。只剩主阅读器时整个分屏拆掉。 */
  removeCell(tabID, cell) {
    return this._enqueue(tabID, async () => {
      let L = this._layouts.get(tabID);
      if (!L || cell.main) return;
      let pos = this._locate(L, cell);
      if (!pos) return;
      let col = L.columns[pos[0]];
      col.cells.splice(pos[1], 1);
      this._disposeReader(cell.reader);
      if (!col.cells.length) {
        L.columns.splice(pos[0], 1);
        this._equalizeColumns(L);
      }
      else {
        this._equalizeRows(col);
      }
      if (this._cells(L).length === 1) {
        this._teardown(tabID, { clearData: true });
        return;
      }
      this._render(L);
      this._save(L);
    });
  },

  /** 关掉标签里所有分屏，只留主阅读器。 */
  closeAll(tabID) {
    return this._enqueue(tabID, async () => this._teardown(tabID, { clearData: true }));
  },

  _canMove(L, cell, dir) {
    let pos = this._locate(L, cell);
    if (!pos) return false;
    let [ci, ri] = pos;
    let col = L.columns[ci];
    if (dir === "up") return ri > 0;
    if (dir === "down") return ri < col.cells.length - 1;
    let target = ci + (dir === "left" ? -1 : 1);
    if (target < 0 || target >= L.columns.length) {
      // 移出最边上：新开一列，前提是自己这列不止它一个
      return col.cells.length > 1 && L.columns.length < MAX_COLUMNS;
    }
    return L.columns[target].cells.length < MAX_ROWS;
  },

  /**
   * 移动一格：left/right 移到相邻一列的底部（在最边上且自己这列不止一格时，新开一列），
   * up/down 和同一列里上下相邻的格子对调。
   */
  moveCell(tabID, cell, dir) {
    let L = this._layouts.get(tabID);
    if (!L || !this._canMove(L, cell, dir)) return false;
    let [ci, ri] = this._locate(L, cell);
    let col = L.columns[ci];
    if (dir === "up" || dir === "down") {
      let rj = ri + (dir === "up" ? -1 : 1);
      let other = col.cells[rj];
      // 高度跟着位置走，不跟着格子走
      [cell.h, other.h] = [other.h, cell.h];
      col.cells[ri] = other;
      col.cells[rj] = cell;
    }
    else {
      let target = ci + (dir === "left" ? -1 : 1);
      col.cells.splice(ri, 1);
      if (target < 0 || target >= L.columns.length) {
        let fresh = { w: 0, cells: [cell] };
        if (target < 0) L.columns.unshift(fresh);
        else L.columns.push(fresh);
        cell.h = 1;
        this._equalizeRows(col);
        this._equalizeColumns(L);
      }
      else {
        let dest = L.columns[target];
        dest.cells.push(cell);
        this._equalizeRows(dest);
        if (!col.cells.length) {
          L.columns.splice(ci, 1);
          this._equalizeColumns(L);
        }
        else {
          this._equalizeRows(col);
        }
      }
    }
    this._render(L);
    this._save(L);
    return true;
  },

  // ================================================================ 布局的数据

  _cells(L) {
    return L.columns.flatMap((c) => c.cells);
  },

  _locate(L, cell) {
    for (let ci = 0; ci < L.columns.length; ci++) {
      let ri = L.columns[ci].cells.indexOf(cell);
      if (ri !== -1) return [ci, ri];
    }
    return null;
  },

  _equalizeColumns(L) {
    for (let col of L.columns) col.w = 1 / L.columns.length;
  },

  _equalizeRows(col) {
    for (let cell of col.cells) cell.h = 1 / col.cells.length;
  },

  _save(L) {
    let round = (x) => Math.round(x * 10000) / 10000;
    L.win.Zotero_Tabs.setTabData(L.tabID, {
      splitReader: {
        v: 2,
        columns: L.columns.map((col) => ({
          w: round(col.w),
          cells: col.cells.map((c) => (c.main ? { main: true, h: round(c.h) } : { itemID: c.itemID, h: round(c.h) }))
        }))
      }
    });
  },

  /** 读标签数据里的布局记录；0.1 版的 {itemID, ratio, swapped} 自动转成两列。 */
  _specFromData(data) {
    if (!data) return null;
    if (data.v === 2 && Array.isArray(data.columns)) return data;
    if (data.itemID) {
      let ratio = typeof data.ratio === "number" ? data.ratio : 0.5;
      let main = { w: ratio, cells: [{ main: true, h: 1 }] };
      let right = { w: 1 - ratio, cells: [{ itemID: data.itemID, h: 1 }] };
      return { v: 2, columns: data.swapped ? [{ ...right, w: ratio }, { ...main, w: 1 - ratio }] : [main, right] };
    }
    return null;
  },

  // ================================================================ 搭建与拆除

  /** 同一个标签上的操作排队执行，免得恢复布局和用户操作同时改同一个标签。 */
  _enqueue(tabID, fn) {
    let prev = this._queues.get(tabID) || Promise.resolve();
    let next = prev.catch(() => {}).then(fn);
    this._queues.set(tabID, next);
    next.catch(() => {}).finally(() => {
      if (this._queues.get(tabID) === next) this._queues.delete(tabID);
    });
    return next;
  },

  async _waitForTabReader(tabID, timeout = 20000) {
    let start = Date.now();
    while (Date.now() - start < timeout) {
      let reader = Zotero.Reader.getByTabID(tabID);
      if (reader && !reader._isTabClosed) {
        await reader._initPromise;
        return reader;
      }
      await Zotero.Promise.delay(50);
    }
    return null;
  },

  /** 拿到标签的布局；还没有就建一个，标签数据里有记录的话照记录把各格搭起来。 */
  async _ensureLayout(win, tabID) {
    let existing = this._layouts.get(tabID);
    if (existing) return existing;
    let readerA = await this._waitForTabReader(tabID);
    if (!readerA) throw new Error(`Split Reader: 标签 ${tabID} 的阅读器没有加载出来`);
    let container = win.document.getElementById(tabID);
    let L = {
      tabID,
      win,
      container,
      readerA,
      prevStyle: container.getAttribute("style"),
      columns: [],
      decor: [],
      overlay: null
    };
    let mainCell = { main: true, itemID: readerA.itemID, reader: readerA, h: 1 };
    let spec = this._specFromData(win.Zotero_Tabs._getTab(tabID)?.tab?.data?.splitReader);
    let seen = new Set([readerA.itemID]);
    let hasMain = false;
    for (let colSpec of spec?.columns || []) {
      if (L.columns.length >= MAX_COLUMNS) break;
      let col = { w: Number(colSpec.w) || 0, cells: [] };
      for (let cellSpec of colSpec.cells || []) {
        if (col.cells.length >= MAX_ROWS) break;
        let h = Number(cellSpec.h) || 0;
        if (cellSpec.main) {
          if (hasMain) continue;
          hasMain = true;
          mainCell.h = h;
          col.cells.push(mainCell);
          continue;
        }
        let item = Zotero.Items.get(cellSpec.itemID);
        if (!item?.attachmentReaderType || item.deleted || seen.has(item.id)) continue;
        seen.add(item.id);
        col.cells.push({ main: false, itemID: item.id, reader: null, h });
      }
      if (col.cells.length) L.columns.push(col);
    }
    if (!hasMain) {
      if (L.columns.length < MAX_COLUMNS) {
        L.columns.unshift({ w: 0, cells: [mainCell] });
        this._equalizeColumns(L);
      }
      else {
        // 记录坏了：主阅读器总得有个位置
        L.columns[0].cells.unshift(mainCell);
        if (L.columns[0].cells.length > MAX_ROWS) L.columns[0].cells.length = MAX_ROWS;
      }
    }
    // 比例加起来不是 1（记录被改过、或者丢了几格）时重新归一
    let totalW = sum(L.columns.map((c) => c.w));
    for (let col of L.columns) {
      col.w = totalW > 0 && col.w > 0 ? col.w / totalW : 1 / L.columns.length;
      let totalH = sum(col.cells.map((c) => c.h));
      for (let cell of col.cells) cell.h = totalH > 0 && cell.h > 0 ? cell.h / totalH : 1 / col.cells.length;
    }
    if (L.columns.some((c) => c.w <= 0) || Math.abs(sum(L.columns.map((c) => c.w)) - 1) > 1e-6) {
      this._equalizeColumns(L);
    }

    this._layouts.set(tabID, L);
    container.style.position = "relative";
    for (let cell of this._cells(L)) {
      if (!cell.main) cell.reader = this._createReader(win, tabID, readerA, Zotero.Items.get(cell.itemID));
    }
    if (this._cells(L).length > 1) {
      this._render(L);
      this._save(L);
    }
    return L;
  },

  /** 用主阅读器的类（ReaderTab）在同一个标签里再构造一个阅读器；参数照抄 Zotero.Reader.open。 */
  _createReader(win, tabID, readerA, item) {
    let ReaderTab = readerA.constructor;
    let R = Zotero.Reader;
    let reader = new ReaderTab({
      item,
      tabID,
      background: win.Zotero_Tabs.selectedID !== tabID,
      sidebarWidth: R._sidebarWidth,
      sidebarOpen: R._sidebarOpen,
      contextPaneOpen: !win.ZoteroContextPane.collapsed,
      bottomPlaceholderHeight: R._bottomPlaceholderHeight,
      onToggleSidebar: (open) => {
        R._sidebarOpen = open;
        R.onToggleSidebar?.(open);
      },
      onChangeSidebarWidth: (width) => {
        R._sidebarWidth = width;
        R.onChangeSidebarWidth?.(width);
      }
    });
    // Zotero 在附件被删除或移进回收站时会调用 reader.close()，对 ReaderTab 来说就是关掉整个标签。
    // 分屏里的格子只应该关自己。阅读器对象是个 Proxy，没有 defineProperty 拦截，
    // 所以 defineProperty 直接落在真正的对象上。
    Object.defineProperty(reader, "close", {
      configurable: true,
      writable: true,
      value: () => {
        let L = this._layouts.get(tabID);
        let cell = L && this._cells(L).find((c) => c.reader === reader);
        if (cell) this.removeCell(tabID, cell);
      }
    });
    Object.defineProperty(reader, "_splitReaderPane", { configurable: true, writable: true, value: true });
    R._readers.push(reader);
    return reader;
  },

  _disposeReader(reader) {
    if (!reader) return;
    try {
      reader.uninit();
    }
    catch (e) {
      Zotero.logError(e);
    }
    // ReaderTab 构造时把自己的 _handleTabClose 接到了标签的 onClose 上，还在标签容器上挂了
    // 三个匿名监听器（侧栏布局、底部占位、右侧面板开关），都拆不掉；标签容器还活着时它们照样会被
    // 触发。让这些回调之后什么也不做，否则会去碰已经销毁的阅读器页面（"can't access dead object"）。
    let define = (key, value) => Object.defineProperty(reader, key, { configurable: true, writable: true, value });
    define("_isTabClosed", true);
    define("_blockingObserver", null);
    define("_internalReader", null);
    for (let method of ["setContextPaneOpen", "setBottomPlaceholderHeight", "_updateLayout", "close"]) {
      define(method, () => {});
    }
    let readers = Zotero.Reader._readers;
    let index = readers.indexOf(reader);
    if (index !== -1) readers.splice(index, 1);
    for (let el of [reader._iframe, reader._popupset]) {
      try {
        el?.remove();
      }
      catch (e) {}
    }
  },

  _teardown(tabID, { clearData }) {
    let L = this._layouts.get(tabID);
    if (!L) return;
    this._layouts.delete(tabID);
    for (let cell of this._cells(L)) {
      if (!cell.main) this._disposeReader(cell.reader);
    }
    for (let el of [...L.decor, L.overlay]) {
      try {
        el?.remove();
      }
      catch (e) {}
    }
    try {
      let a = L.readerA._iframe;
      if (a && a.isConnected) {
        for (let prop of POSITION_PROPS) a.style.removeProperty(prop);
        a.setAttribute("flex", "1");
      }
      if (L.container.isConnected) {
        if (L.prevStyle === null) L.container.removeAttribute("style");
        else L.container.setAttribute("style", L.prevStyle);
      }
    }
    catch (e) {}
    if (clearData) {
      try {
        if (L.win.Zotero_Tabs._getTab(tabID)?.tab) {
          L.win.Zotero_Tabs.setTabData(tabID, { splitReader: undefined });
        }
      }
      catch (e) {}
    }
  },

  // ================================================================ 摆放与覆盖层

  /** 重建分隔条和每格的小工具条，再摆放所有东西。结构变了（加、删、移动格子）时调用。 */
  _render(L) {
    for (let el of L.decor) el.remove();
    L.decor = [];
    L.columns.forEach((col, ci) => {
      if (ci > 0) L.decor.push(this._makeSplitter(L, { type: "col", ci }));
      for (let ri = 1; ri < col.cells.length; ri++) {
        L.decor.push(this._makeSplitter(L, { type: "row", ci, ri }));
      }
    });
    for (let cell of this._cells(L)) {
      L.decor.push(this._makeCellBar(L, cell));
    }
    for (let el of L.decor) L.container.appendChild(el);
    this._position(L);
  },

  /** 按比例摆放各格的 <browser> 和覆盖层。拖分隔条时只调这个。 */
  _position(L) {
    let half = GAP / 2;
    let n = L.columns.length;
    let set = (el, styles) => {
      for (let [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
    };
    let x = 0;
    let colBox = [];
    L.columns.forEach((col, ci) => {
      let x0 = x;
      let x1 = ci === n - 1 ? 1 : x + col.w;
      x = x1;
      let padL = ci > 0 ? half : 0;
      let padR = ci < n - 1 ? half : 0;
      colBox[ci] = { x0, x1, left: pct(x0, padL), width: pct(x1 - x0, -(padL + padR)) };
      let y = 0;
      col.cells.forEach((cell, ri) => {
        let y0 = y;
        let y1 = ri === col.cells.length - 1 ? 1 : y + cell.h;
        y = y1;
        let padT = ri > 0 ? half : 0;
        let padB = ri < col.cells.length - 1 ? half : 0;
        cell._box = { x0, x1, y0, y1, padR, padB };
        let el = cell.reader?._iframe;
        if (!el) return;
        // <browser flex="1"> 的 XUL 属性会压过普通的内联样式，所以去掉属性、再用 !important
        el.removeAttribute("flex");
        set(el, {
          position: "absolute",
          margin: "0",
          "min-width": "0",
          "min-height": "0",
          left: colBox[ci].left,
          width: colBox[ci].width,
          top: pct(y0, padT),
          height: pct(y1 - y0, -(padT + padB))
        });
      });
    });
    for (let el of L.decor) {
      let d = el._split;
      if (d.type === "col") {
        set(el, { left: pct(colBox[d.ci].x0, -half), width: `${GAP}px`, top: "0", height: "100%" });
      }
      else if (d.type === "row") {
        let cell = L.columns[d.ci].cells[d.ri];
        set(el, {
          left: colBox[d.ci].left,
          width: colBox[d.ci].width,
          top: pct(cell._box.y0, -half),
          height: `${GAP}px`
        });
      }
      else if (d.type === "bar") {
        let b = d.cell._box;
        if (!b) continue;
        set(el, { right: pct(1 - b.x1, b.padR + 8), bottom: pct(1 - b.y1, b.padB + 8) });
      }
    }
  },

  _makeSplitter(L, info) {
    let doc = L.win.document;
    let el = doc.createElementNS(HTML_NS, "div");
    el._split = info;
    el.className = "split-reader-splitter";
    el.setAttribute("role", "separator");
    Object.assign(el.style, {
      position: "absolute",
      zIndex: "5",
      cursor: info.type === "col" ? "col-resize" : "row-resize",
      background: "var(--fill-quinary, rgba(128,128,128,.25))",
      boxSizing: "border-box",
      [info.type === "col" ? "borderInline" : "borderBlock"]: "1px solid var(--fill-quarternary, rgba(128,128,128,.35))"
    });
    el.addEventListener("dblclick", () => {
      if (info.type === "col") this._equalizeColumns(L);
      else this._equalizeRows(L.columns[info.ci]);
      this._position(L);
      this._save(L);
    });
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // 拖动时盖一层透明遮罩，否则鼠标进了阅读器的 iframe 就收不到移动事件
      let overlay = doc.createElementNS(HTML_NS, "div");
      Object.assign(overlay.style, {
        position: "absolute",
        inset: "0",
        zIndex: "100",
        cursor: el.style.cursor
      });
      L.container.appendChild(overlay);
      L.overlay = overlay;
      let rect = L.container.getBoundingClientRect();
      let move = (e) => {
        if (info.type === "col") {
          let a = L.columns[info.ci - 1];
          let b = L.columns[info.ci];
          let start = sum(L.columns.slice(0, info.ci - 1).map((c) => c.w));
          let end = start + a.w + b.w;
          let pos = (e.clientX - rect.left) / rect.width;
          pos = Math.min(end - MIN_FRACTION, Math.max(start + MIN_FRACTION, pos));
          a.w = pos - start;
          b.w = end - pos;
        }
        else {
          let col = L.columns[info.ci];
          let a = col.cells[info.ri - 1];
          let b = col.cells[info.ri];
          let start = sum(col.cells.slice(0, info.ri - 1).map((c) => c.h));
          let end = start + a.h + b.h;
          let pos = (e.clientY - rect.top) / rect.height;
          pos = Math.min(end - MIN_FRACTION, Math.max(start + MIN_FRACTION, pos));
          a.h = pos - start;
          b.h = end - pos;
        }
        this._position(L);
      };
      let up = () => {
        overlay.removeEventListener("pointermove", move);
        overlay.removeEventListener("pointerup", up);
        overlay.remove();
        L.overlay = null;
        this._save(L);
      };
      overlay.addEventListener("pointermove", move);
      overlay.addEventListener("pointerup", up);
    });
    return el;
  },

  /** 每格右下角的小工具条：← → ↑ ↓ 移动，× 关闭（主阅读器那格没有 ×）。只有一格时不显示。 */
  _makeCellBar(L, cell) {
    let doc = L.win.document;
    let bar = doc.createElementNS(HTML_NS, "div");
    bar._split = { type: "bar", cell };
    bar.className = "split-reader-cellbar";
    let single = this._cells(L).length < 2;
    Object.assign(bar.style, {
      position: "absolute",
      zIndex: "6",
      display: single ? "none" : "flex",
      gap: "2px",
      padding: "2px",
      borderRadius: "6px",
      background: "var(--material-toolbar, rgba(245,245,245,.95))",
      boxShadow: "0 1px 4px rgba(0,0,0,.25)",
      opacity: "0.55",
      transition: "opacity .15s"
    });
    bar.addEventListener("mouseenter", () => (bar.style.opacity = "1"));
    bar.addEventListener("mouseleave", () => (bar.style.opacity = "0.55"));
    let buttons = [
      ["left", "←", "split-reader-move-left"],
      ["right", "→", "split-reader-move-right"],
      ["up", "↑", "split-reader-move-up"],
      ["down", "↓", "split-reader-move-down"]
    ];
    if (!cell.main) buttons.push(["close", "×", "split-reader-close-pane"]);
    for (let [action, glyph, l10nID] of buttons) {
      let btn = doc.createElementNS(HTML_NS, "button");
      btn.className = `split-reader-${action}`;
      btn.textContent = glyph;
      btn.setAttribute("data-l10n-id", l10nID);
      btn.setAttribute("tooltip", "html-tooltip");
      Object.assign(btn.style, {
        minWidth: "22px",
        height: "22px",
        padding: "0 4px",
        border: "none",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fill-primary, #333)",
        font: "13px system-ui, sans-serif",
        cursor: "pointer"
      });
      if (action !== "close" && !this._canMove(L, cell, action)) {
        btn.disabled = true;
        btn.style.opacity = "0.3";
        btn.style.cursor = "default";
      }
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (action === "close") this.removeCell(L.tabID, cell);
        else this.moveCell(L.tabID, cell, action);
      });
      bar.appendChild(btn);
    }
    return bar;
  },

  // ================================================================ 标签事件

  notify(event, type, ids) {
    if (type !== "tab") return;
    let flatIDs = ids.flat(Infinity);
    if (event === "close") {
      for (let id of flatIDs) {
        if (this._layouts.has(id)) this._teardown(id, { clearData: false });
      }
    }
    else if (event === "load") {
      for (let id of flatIDs) {
        let win = this._windowForTab(id);
        if (win) this._restoreTab(win, id);
      }
    }
  },

  _windowForTab(tabID) {
    return Zotero.getMainWindows().find((win) => win.Zotero_Tabs?._getTab(tabID)?.tab);
  },

  _restoreTab(win, tabID) {
    let tab = win.Zotero_Tabs._getTab(tabID)?.tab;
    if (!tab || tab.type !== "reader" || this._layouts.has(tabID)) return;
    if (!this._specFromData(tab.data?.splitReader)) return;
    this._enqueue(tabID, () => this._ensureLayout(win, tabID)).catch((e) => Zotero.logError(e));
  },

  _restoreAll(win) {
    if (!win.Zotero_Tabs) return;
    for (let tab of win.Zotero_Tabs._tabs) {
      this._restoreTab(win, tab.id);
    }
  },

  // ================================================================ 菜单

  _registerMenus() {
    // 一个“槽位”菜单项：显示与否、能不能点、文字、点了做什么，都在弹出时现算。
    // MenuManager 只接受注册时固定的菜单结构，所以动态列表用固定数量的槽位来做。
    let slot = (i, l10nID, list, onPick) => ({
      menuType: "menuitem",
      l10nID,
      onShowing: (event, ctx) => {
        let entry = list(event.target.ownerGlobal, ctx)[i];
        ctx.setVisible(!!entry);
        if (entry) {
          ctx.menuElem._splitReaderEntry = entry;
          ctx.setEnabled(!entry.disabled);
          ctx.setL10nArgs(JSON.stringify(entry.l10nArgs));
        }
      },
      onCommand: (event, ctx) => {
        let entry = event.target._splitReaderEntry;
        if (entry && !entry.disabled) onPick(event.target.ownerGlobal, ctx, entry).catch((e) => Zotero.logError(e));
      }
    });
    let slots = (...args) => Array.from({ length: MAX_SLOTS }, (_, i) => slot(i, ...args));

    // ---- 文库条目右键
    let targetList = (win, ctx) => {
      let att = this._singleAttachment(ctx.items);
      return att ? this._targetTabs(win, att) : [];
    };
    let itemMenu = Zotero.MenuManager.registerMenu({
      menuID: "split-reader-item",
      pluginID: this.id,
      target: "main/library/item",
      menus: [
        {
          // 选中一个附件或条目：加进某个已打开的阅读标签的分屏
          menuType: "submenu",
          l10nID: "split-reader-open-in-tab",
          onShowing: (event, ctx) => {
            ctx.setVisible(targetList(event.target.ownerGlobal, ctx).length > 0);
          },
          menus: slots("split-reader-target-tab", targetList, async (win, ctx, entry) => {
            await this.openInTab(win, entry.tabID, entry.att);
          })
        },
        {
          // 选中几个条目，或一个带多份 PDF 的条目：新开一个标签，全部摆好
          menuType: "menuitem",
          l10nID: "split-reader-open",
          onShowing: (event, ctx) => {
            let atts = this._togetherAttachments(ctx.items);
            ctx.setVisible(!!atts);
            if (atts) {
              let max = MAX_COLUMNS * MAX_ROWS;
              ctx.setEnabled(atts.length <= max);
              ctx.setL10nArgs(JSON.stringify({ count: atts.length, max, over: atts.length > max ? "yes" : "no" }));
            }
          },
          onCommand: (event, ctx) => {
            let atts = this._togetherAttachments(ctx.items);
            if (!atts || atts.length > MAX_COLUMNS * MAX_ROWS) return;
            this.openTogether(event.target.ownerGlobal, atts).catch((e) => Zotero.logError(e));
          }
        }
      ]
    });

    // ---- 阅读标签的标签页右键
    let readerTab = (ctx) => ctx.tabType === "reader" && ctx.tabID;
    let candidateList = (win, ctx) => (readerTab(ctx) ? this._candidates(win, ctx.tabID) : []);
    let tabMenu = Zotero.MenuManager.registerMenu({
      menuID: "split-reader-tab",
      pluginID: this.id,
      target: "main/tab",
      menus: [
        {
          menuType: "submenu",
          l10nID: "split-reader-show-right",
          onShowing: (event, ctx) => ctx.setVisible(!!readerTab(ctx)),
          menus: [
            ...slots("split-reader-candidate", candidateList, async (win, ctx, entry) => {
              let item = Zotero.Items.get(entry.itemID);
              await this.openInTab(win, ctx.tabID, item);
              // 从已打开的标签挑的：它已经并进来了，把原来的标签关掉（那个标签自己有分屏时不关）
              if (entry.kind === "tab" && win.Zotero_Tabs._getTab(entry.tabID)?.tab &&
                  !this._layouts.has(entry.tabID) &&
                  this._tabContents(win, ctx.tabID).itemIDs.has(entry.itemID)) {
                win.Zotero_Tabs.close(entry.tabID);
              }
            }),
            {
              menuType: "separator",
              onShowing: (event, ctx) => {
                ctx.setVisible(candidateList(event.target.ownerGlobal, ctx).length > 0);
              }
            },
            {
              menuType: "menuitem",
              l10nID: "split-reader-pick-from-library",
              onCommand: (event, ctx) => {
                this.pickFromLibrary(event.target.ownerGlobal, ctx.tabID).catch((e) => Zotero.logError(e));
              }
            }
          ]
        },
        {
          menuType: "menuitem",
          l10nID: "split-reader-close-right",
          onShowing: (event, ctx) => ctx.setVisible(this._layouts.has(ctx.tabID)),
          onCommand: (event, ctx) => {
            this.closeAll(ctx.tabID).catch((e) => Zotero.logError(e));
          }
        }
      ]
    });

    this._menuIDs = [itemMenu, tabMenu].filter(Boolean);
  }
};
