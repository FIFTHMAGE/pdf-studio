(function () {
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
  const { PDFDocument, StandardFonts, rgb, degrees, PDFName } = PDFLib;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function hexToRgbObj(hex) {
    const v = hex.replace("#", "");
    const n = parseInt(v, 16);
    return { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 };
  }
  function hexToPdfColor(hex) {
    const c = hexToRgbObj(hex);
    return rgb(c.r, c.g, c.b);
  }
  function hexToCss(hex) { return hex; }

  const COLORS = ["#2E6FE0", "#C7402B", "#1F9D6E", "#B8860B", "#8A4FD6", "#16202B"];

  const state = {
    sources: {},
    pages: [],
    currentIndex: -1,
    zoom: 1,
    fitMode: "width",
    mode: "view",
    tool: null,
    color: COLORS[0],
    strokeWidth: 3,
    fontSize: 16,
    selectedAnnoId: null,
    selectPages: false,
    selectedPageIds: new Set(),
    pendingPlacement: null,
    formsDoc: null,
    formsSourceId: null,
    formsFields: [],
    flattenForms: false,
    sigMode: "draw",
    downloadsCap: null,
    currentViewport: null,
    docLabel: "",
    undoStack: [],
    redoStack: [],
  };

  (async function initCapability() {
    try {
      if (window.claude && typeof window.claude.use === "function") {
        state.downloadsCap = await window.claude.use("downloads");
      }
    } catch (e) { state.downloadsCap = null; }
  })();

  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (kind === "err" ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = "toast"; }, 2600);
  }

  function setStatus(msg) { $("#statusMsg").textContent = msg || ""; }

  async function triggerDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    if (state.downloadsCap) {
      try {
        await state.downloadsCap.save({ filename, data: blob });
        toast("Saved " + filename);
        return;
      } catch (e) {
        if (e && e.code === "declined") return;
        toast("Couldn't save: " + (e && e.message ? e.message : "unknown error"), "err");
        return;
      }
    }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast("Saved " + filename);
    } catch (e) {
      toast("Download unavailable in this view", "err");
    }
  }

  function guessMime(file) {
    if (file.type) return file.type;
    const n = file.name.toLowerCase();
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".pdf")) return "application/pdf";
    return "image/jpeg";
  }

  async function fileToBytes(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  function bytesToDataURL(bytes, mime) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return "data:" + mime + ";base64," + btoa(binary);
  }

  async function loadImageDims(dataURL) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 400, h: 400 });
      img.src = dataURL;
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    pushHistory();
    let added = 0;
    for (const file of files) {
      const mime = guessMime(file);
      try {
        if (mime === "application/pdf") {
          await addPdfSource(file);
        } else if (mime === "image/jpeg" || mime === "image/png") {
          await addImageSource(file, mime);
        } else {
          toast(file.name + ": unsupported file type", "err");
          continue;
        }
        added++;
      } catch (e) {
        console.error(e);
        toast("Couldn't open " + file.name, "err");
      }
    }
    if (added) {
      $("#emptyState").style.display = "none";
      $("#pageStage").style.display = "";
      if (state.currentIndex < 0) state.currentIndex = 0;
      if (!state.docLabel) state.docLabel = files[0].name;
      updateDocName();
      renderRail();
      await renderCurrentPage();
      updateModeAvailability();
      renderPanel();
      $("#exportBtn").disabled = state.pages.length === 0;
      updateHistoryButtons();
    } else {
      state.undoStack.pop();
    }
  }

  async function addPdfSource(file) {
    const bytes = await fileToBytes(file);
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const sourceId = uid();
    state.sources[sourceId] = {
      id: sourceId, kind: "pdf", name: file.name, bytes, pdfjsDoc, numPages: pdfjsDoc.numPages,
    };
    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      state.pages.push({
        id: uid(), kind: "pdf", sourceId, sourcePageIndex: i,
        baseRotation: page.rotate || 0, userRotation: 0,
        widthPt: vp.width, heightPt: vp.height,
        annotations: [],
      });
    }
  }

  function computeImagePageSize(w, h) {
    const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;
    const landscape = w > h;
    const pageW = landscape ? PAGE_H : PAGE_W;
    const pageH = landscape ? PAGE_W : PAGE_H;
    return { pageW, pageH };
  }

  async function addImageSource(file, mime) {
    const bytes = await fileToBytes(file);
    const dataURL = bytesToDataURL(bytes, mime);
    const dims = await loadImageDims(dataURL);
    const sourceId = uid();
    state.sources[sourceId] = { id: sourceId, kind: "image", name: file.name, bytes, mime, dataURL, w: dims.w, h: dims.h };
    const { pageW, pageH } = computeImagePageSize(dims.w, dims.h);
    state.pages.push({
      id: uid(), kind: "image", sourceId, sourcePageIndex: 0,
      baseRotation: 0, userRotation: 0,
      widthPt: pageW, heightPt: pageH,
      annotations: [],
    });
  }

  function updateDocName() {
    const el = $("#docName");
    if (state.docLabel) {
      el.textContent = state.docLabel + (state.pages.length > 1 ? " +" + (state.pages.length - 1) : "");
      el.classList.add("show");
    }
  }

  function pageDisplaySize(pg) {
    const rot = ((pg.baseRotation + pg.userRotation) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) return { w: pg.heightPt, h: pg.widthPt };
    return { w: pg.widthPt, h: pg.heightPt };
  }

  function fitScaleFor(pg, containerWidth) {
    const disp = pageDisplaySize(pg);
    return Math.max(0.1, (containerWidth - 48) / disp.w);
  }

  let renderSeq = 0;
  let activeRenderTask = null;

  async function renderCurrentPage() {
    const seq = ++renderSeq;
    // pdf.js corrupts the canvas (upside-down pages) if two renders overlap on it.
    if (activeRenderTask) {
      const prev = activeRenderTask;
      try { prev.cancel(); } catch (e) { /* already finished */ }
      try { await prev.promise; } catch (e) { /* cancelled */ }
    }
    if (seq !== renderSeq) return;
    if (state.currentIndex < 0 || state.currentIndex >= state.pages.length) {
      $("#pageStage").style.display = "none";
      $("#emptyState").style.display = "flex";
      return;
    }
    const pg = state.pages[state.currentIndex];
    const stage = $("#stage");
    if (state.fitMode === "width") {
      state.zoom = fitScaleFor(pg, stage.clientWidth);
    }
    const scale = state.zoom;
    const pageCanvas = $("#pageCanvas");
    const markCanvas = $("#markCanvas");
    const pageStageEl = $("#pageStage");
    const rot = ((pg.baseRotation + pg.userRotation) % 360 + 360) % 360;

    if (pg.kind === "pdf") {
      const src = state.sources[pg.sourceId];
      const page = await src.pdfjsDoc.getPage(pg.sourcePageIndex + 1);
      if (seq !== renderSeq) return;
      const viewport = page.getViewport({ scale, rotation: rot });
      state.currentViewport = viewport;
      pageCanvas.width = viewport.width; pageCanvas.height = viewport.height;
      const ctx = pageCanvas.getContext("2d");
      const task = page.render({ canvasContext: ctx, viewport });
      activeRenderTask = task;
      try {
        await task.promise;
      } catch (e) {
        if (e && e.name === "RenderingCancelledException") return;
        throw e;
      } finally {
        if (activeRenderTask === task) activeRenderTask = null;
      }
      if (seq !== renderSeq) return;
    } else {
      state.currentViewport = null;
      const disp = pageDisplaySize(pg);
      pageCanvas.width = disp.w * scale; pageCanvas.height = disp.h * scale;
      const ctx = pageCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      const src = state.sources[pg.sourceId];
      const img = await loadedImageEl(src.dataURL);
      if (seq !== renderSeq) return;
      const MARGIN = 36 * scale;
      const availW = pageCanvas.width - MARGIN * 2;
      const availH = pageCanvas.height - MARGIN * 2;
      const s = Math.min(availW / img.naturalWidth, availH / img.naturalHeight, 1000);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      const dx = (pageCanvas.width - dw) / 2, dy = (pageCanvas.height - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    }
    pageStageEl.style.width = pageCanvas.width + "px";
    pageStageEl.style.height = pageCanvas.height + "px";
    markCanvas.width = pageCanvas.width; markCanvas.height = pageCanvas.height;

    $("#pageCounter").textContent = (state.currentIndex + 1) + " / " + state.pages.length;
    $("#zoomPct").textContent = Math.round(scale * 100) + "%";

    redrawMarks();
    renderOverlayBoxes();
    if (state.mode === "forms") renderFormsOverlay();
    highlightCurrentThumb();
  }

  const _imgCache = {};
  function loadedImageEl(dataURL) {
    if (_imgCache[dataURL]) return Promise.resolve(_imgCache[dataURL]);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { _imgCache[dataURL] = img; resolve(img); };
      img.src = dataURL;
    });
  }

  function toPdfPoint(px, py) {
    const pg = state.pages[state.currentIndex];
    if (pg.kind === "pdf" && state.currentViewport) {
      const [x, y] = state.currentViewport.convertToPdfPoint(px, py);
      return { x, y };
    }
    const scale = state.zoom;
    const disp = pageDisplaySize(pg);
    return { x: px / scale, y: disp.h - py / scale };
  }
  function toScreenPoint(x, y) {
    const pg = state.pages[state.currentIndex];
    if (pg.kind === "pdf" && state.currentViewport) {
      const [px, py] = state.currentViewport.convertToViewportPoint(x, y);
      return { x: px, y: py };
    }
    const scale = state.zoom;
    const disp = pageDisplaySize(pg);
    return { x: x * scale, y: (disp.h - y) * scale };
  }

  function redrawMarks() {
    const canvas = $("#markCanvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pg = state.pages[state.currentIndex];
    if (!pg) return;
    for (const a of pg.annotations) {
      if (a.type === "highlight") {
        const p1 = toScreenPoint(a.x, a.y), p2 = toScreenPoint(a.x + a.w, a.y + a.h);
        ctx.fillStyle = hexToCss(a.color);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        ctx.globalAlpha = 1;
      } else if (a.type === "whiteout") {
        const p1 = toScreenPoint(a.x, a.y), p2 = toScreenPoint(a.x + a.w, a.y + a.h);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        ctx.strokeStyle = "#00000022";
        ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      } else if (a.type === "draw") {
        if (a.points.length < 2) continue;
        ctx.strokeStyle = hexToCss(a.color);
        ctx.lineWidth = a.strokeWidth * state.zoom;
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath();
        const p0 = toScreenPoint(a.points[0].x, a.points[0].y);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < a.points.length; i++) {
          const p = toScreenPoint(a.points[i].x, a.points[i].y);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    if (state._liveStroke) {
      const pts = state._liveStroke.points;
      if (pts.length > 1) {
        ctx.strokeStyle = hexToCss(state.color);
        ctx.lineWidth = state.strokeWidth * state.zoom;
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
    if (state._liveRect) {
      const r = state._liveRect;
      ctx.fillStyle = r.kind === "whiteout" ? "#ffffff" : hexToCss(state.color);
      ctx.globalAlpha = r.kind === "whiteout" ? 1 : 0.35;
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.globalAlpha = 1;
    }
    if (state.selectedAnnoId) {
      const sel = pg.annotations.find((a) => a.id === state.selectedAnnoId);
      if (sel && (sel.type === "highlight" || sel.type === "whiteout" || sel.type === "draw")) {
        drawSelectionOutline(ctx, sel);
      }
    }
  }

  function drawSelectionOutline(ctx, a) {
    ctx.save();
    ctx.strokeStyle = "#2E6FE0";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    if (a.type === "highlight" || a.type === "whiteout") {
      const p1 = toScreenPoint(a.x, a.y), p2 = toScreenPoint(a.x + a.w, a.y + a.h);
      const x = Math.min(p1.x, p2.x) - 3, y = Math.min(p1.y, p2.y) - 3;
      const w = Math.abs(p2.x - p1.x) + 6, h = Math.abs(p2.y - p1.y) + 6;
      ctx.strokeRect(x, y, w, h);
    } else if (a.type === "draw") {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of a.points) {
        const sp = toScreenPoint(pt.x, pt.y);
        minX = Math.min(minX, sp.x); minY = Math.min(minY, sp.y);
        maxX = Math.max(maxX, sp.x); maxY = Math.max(maxY, sp.y);
      }
      const pad = 6 + (a.strokeWidth || 3) * state.zoom / 2;
      ctx.strokeRect(minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2);
    }
    ctx.restore();
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function hitTestAnnotationAt(px, py) {
    const pg = currentPage();
    if (!pg) return null;
    const p = toPdfPoint(px, py);
    const tol = 8 / (state.zoom || 1);
    for (let i = pg.annotations.length - 1; i >= 0; i--) {
      const a = pg.annotations[i];
      if (a.type === "highlight" || a.type === "whiteout") {
        const x0 = Math.min(a.x, a.x + a.w), x1 = Math.max(a.x, a.x + a.w);
        const y0 = Math.min(a.y, a.y + a.h), y1 = Math.max(a.y, a.y + a.h);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return a.id;
      } else if (a.type === "draw") {
        const lineTol = tol + (a.strokeWidth || 3) / 2;
        for (let j = 1; j < a.points.length; j++) {
          if (distToSegment(p, a.points[j - 1], a.points[j]) <= lineTol) return a.id;
        }
      }
    }
    return null;
  }

  function renderOverlayBoxes() {
    const layer = $("#interactLayer");
    $$(".anno-box").forEach((el) => el.remove());
    const pg = state.pages[state.currentIndex];
    if (!pg) return;
    for (const a of pg.annotations) {
      if (a.type === "text") layer.appendChild(buildTextBox(a));
      if (a.type === "image") layer.appendChild(buildImageBox(a));
    }
  }

  function boxScreenRect(a) {
    const p1 = toScreenPoint(a.x, a.y + a.h);
    const p2 = toScreenPoint(a.x + a.w, a.y);
    return {
      left: Math.min(p1.x, p2.x), top: Math.min(p1.y, p2.y),
      w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y),
    };
  }

  function selectAnno(id) {
    state.selectedAnnoId = id;
    $$(".anno-box").forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
  }

  function makeEdgeResizeHandler(a, edge) {
    return function (e) {
      e.stopPropagation(); e.preventDefault();
      selectAnno(a.id);
      const startX = e.clientX;
      const startRect = boxScreenRect(a);
      const anchorLeft = a.x, anchorRight = a.x + a.w, anchorRowY = startRect.top;
      let historyPushed = false;
      function onMove(ev) {
        if (!historyPushed) { pushHistory(); historyPushed = true; }
        const dx = ev.clientX - startX;
        if (edge === "right") {
          const nw = Math.max(16, startRect.w + dx);
          const p = toPdfPoint(startRect.left + nw, anchorRowY);
          a.w = Math.max(4, p.x - anchorLeft);
        } else {
          const nLeft = startRect.left + dx;
          const p = toPdfPoint(nLeft, anchorRowY);
          const newW = Math.max(4, anchorRight - p.x);
          a.x = anchorRight - newW;
          a.w = newW;
        }
        renderOverlayBoxes(); selectAnno(a.id);
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  }

  function attachBoxChrome(el, a) {
    el.classList.add("anno-box");
    el.dataset.id = a.id;
    const r = boxScreenRect(a);
    el.style.left = r.left + "px"; el.style.top = r.top + "px";
    el.style.width = r.w + "px"; el.style.height = r.h + "px";

    const del = document.createElement("div");
    del.className = "anno-del"; del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      pushHistory();
      const pg = state.pages[state.currentIndex];
      pg.annotations = pg.annotations.filter((x) => x.id !== a.id);
      renderOverlayBoxes(); redrawMarks();
    });
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "anno-handle";
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      selectAnno(a.id);
      const startX = e.clientX, startY = e.clientY;
      const startRect = boxScreenRect(a);
      const anchorTop = a.y + a.h, anchorLeft = a.x;
      let historyPushed = false;
      function onMove(ev) {
        if (!historyPushed) { pushHistory(); historyPushed = true; }
        const nw = Math.max(16, startRect.w + (ev.clientX - startX));
        const nh = Math.max(16, startRect.h + (ev.clientY - startY));
        const brPdf = toPdfPoint(startRect.left + nw, startRect.top + nh);
        const newW = Math.max(4, brPdf.x - anchorLeft);
        const newH = Math.max(4, anchorTop - brPdf.y);
        a.w = newW; a.h = newH; a.y = anchorTop - newH;
        renderOverlayBoxes(); selectAnno(a.id);
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    el.appendChild(handle);

    const rightHandle = document.createElement("div");
    rightHandle.className = "anno-handle-edge anno-handle-right";
    rightHandle.addEventListener("pointerdown", makeEdgeResizeHandler(a, "right"));
    el.appendChild(rightHandle);

    const leftHandle = document.createElement("div");
    leftHandle.className = "anno-handle-edge anno-handle-left";
    leftHandle.addEventListener("pointerdown", makeEdgeResizeHandler(a, "left"));
    el.appendChild(leftHandle);

    return el;
  }

  function buildTextBox(a) {
    const el = document.createElement("div");
    attachBoxChrome(el, a);
    el.addEventListener("pointerdown", startDragHandler(el, a));
    const txt = document.createElement("div");
    txt.className = "anno-text";
    txt.style.width = "100%";
    txt.style.height = "100%";
    txt.contentEditable = "true";
    txt.style.color = a.color;
    txt.style.fontSize = (a.fontSize * state.zoom) + "px";
    txt.style.fontFamily = "'Geist', sans-serif";
    txt.style.lineHeight = "1.25";
    txt.textContent = a.text || "";
    let textHistoryPushed = false;
    txt.addEventListener("pointerdown", (e) => { selectAnno(a.id); e.stopPropagation(); });
    txt.addEventListener("focus", () => { textHistoryPushed = false; });
    txt.addEventListener("blur", () => { textHistoryPushed = false; });
    txt.addEventListener("input", () => {
      if (!textHistoryPushed) { pushHistory(); textHistoryPushed = true; }
      a.text = txt.textContent;
    });
    txt.addEventListener("pointerdown", startDragHandler(el, a), true);
    el.appendChild(txt);
    setTimeout(() => { if (a._focus) { txt.focus(); delete a._focus; placeCaretEnd(txt); } }, 0);
    return el;
  }

  function placeCaretEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }

  function buildImageBox(a) {
    const el = document.createElement("div");
    attachBoxChrome(el, a);
    const img = document.createElement("img");
    img.className = "anno-image";
    img.src = a.dataURL;
    img.draggable = false;
    el.appendChild(img);
    el.addEventListener("pointerdown", startDragHandler(el, a));
    return el;
  }

  function startDragHandler(el, a) {
    return function (e) {
      if (e.target.classList.contains("anno-handle") || e.target.classList.contains("anno-del")) return;
      selectAnno(a.id);
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const r0 = boxScreenRect(a);
      let moved = false;
      let historyPushed = false;
      function onMove(ev) {
        moved = true;
        if (!historyPushed) { pushHistory(); historyPushed = true; }
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        const p1 = toPdfPoint(r0.left + dx, r0.top + dy + r0.h);
        a.x = p1.x; a.y = p1.y;
        renderOverlayBoxes(); selectAnno(a.id);
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  }

  function currentPage() { return state.pages[state.currentIndex]; }

  function isTypingTarget(el) {
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  }

  // ---------------- Undo / redo ----------------
  // History only tracks state.pages (page list + each page's annotations) —
  // the actual editable document. Snapshots are plain-JSON deep clones since
  // pages/annotations never hold functions or live objects.

  const HISTORY_LIMIT = 60;

  function clonePages() { return JSON.parse(JSON.stringify(state.pages)); }

  function pushHistory() {
    state.undoStack.push(clonePages());
    if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
    state.redoStack.length = 0;
    updateHistoryButtons();
  }

  function restorePages(pages) {
    state.pages = pages;
    if (state.currentIndex >= state.pages.length) state.currentIndex = state.pages.length - 1;
    if (state.currentIndex < 0 && state.pages.length) state.currentIndex = 0;
    state.selectedAnnoId = null;
    state.selectedPageIds.clear();
    renderRail();
    renderCurrentPage();
    renderPanel();
    updateModeAvailability();
    $("#exportBtn").disabled = state.pages.length === 0;
    updateHistoryButtons();
  }

  function undo() {
    if (!state.undoStack.length) return;
    const prev = state.undoStack.pop();
    state.redoStack.push(clonePages());
    restorePages(prev);
  }

  function redo() {
    if (!state.redoStack.length) return;
    const next = state.redoStack.pop();
    state.undoStack.push(clonePages());
    restorePages(next);
  }

  function updateHistoryButtons() {
    const undoBtn = $("#undoBtn"), redoBtn = $("#redoBtn");
    if (undoBtn) undoBtn.disabled = state.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
  }

  function setupInteractLayer() {
    const layer = $("#interactLayer");
    let dragging = false;
    let mode = null;

    layer.addEventListener("pointerdown", (e) => {
      if (!currentPage()) return;
      const rect = layer.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const activeTool = getActiveTool();

      const selectableTool = !activeTool || activeTool === "highlight" || activeTool === "whiteout" || activeTool === "draw";
      if (selectableTool) {
        const hitId = hitTestAnnotationAt(px, py);
        if (hitId) { selectAnno(hitId); redrawMarks(); return; }
        if (!activeTool) { selectAnno(null); redrawMarks(); return; }
      }

      if (activeTool === "highlight" || activeTool === "whiteout") {
        dragging = true; mode = activeTool;
        state._liveRect = { x0: px, y0: py, x1: px, y1: py, kind: activeTool };
        try { layer.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer to capture */ }
      } else if (activeTool === "draw") {
        dragging = true; mode = "draw";
        state._liveStroke = { points: [{ x: px, y: py }] };
        try { layer.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer to capture */ }
      } else if (activeTool === "text") {
        const p = toPdfPoint(px, py);
        const a = { id: uid(), type: "text", x: p.x, y: p.y - 20, w: 220, h: 40, text: "", color: state.color, fontSize: state.fontSize, _focus: true };
        pushHistory();
        currentPage().annotations.push(a);
        renderOverlayBoxes();
        selectAnno(a.id);
      } else if (activeTool === "place-image" && state.pendingPlacement) {
        placePendingImageAt(px, py);
      }
    });

    layer.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = layer.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (mode === "draw") {
        state._liveStroke.points.push({ x: px, y: py });
        redrawMarks();
      } else if (state._liveRect) {
        state._liveRect.x1 = px; state._liveRect.y1 = py;
        redrawMarks();
      }
    });

    layer.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      if (mode === "draw" && state._liveStroke) {
        const pts = state._liveStroke.points.map((p) => toPdfPoint(p.x, p.y));
        if (pts.length > 1) {
          pushHistory();
          currentPage().annotations.push({ id: uid(), type: "draw", points: pts, color: state.color, strokeWidth: state.strokeWidth });
        }
        state._liveStroke = null;
      } else if (state._liveRect) {
        const r = state._liveRect;
        const p1 = toPdfPoint(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
        const p2 = toPdfPoint(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
        const w = Math.abs(p2.x - p1.x), h = Math.abs(p1.y - p2.y);
        if (w > 3 && h > 3) {
          pushHistory();
          currentPage().annotations.push({
            id: uid(), type: r.kind, x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w, h,
            color: state.color,
          });
        }
        state._liveRect = null;
      }
      mode = null;
      redrawMarks();
    });
  }

  function getActiveTool() {
    if (state.mode === "annotate") return state.tool;
    if (state.mode === "edit") {
      if (state.tool === "mask") return "whiteout";
      if (state.tool === "text") return "text";
      if (state.tool === "image") return "place-image";
      return null;
    }
    if (state.mode === "sign" && state.tool === "place-sig") return "place-image";
    return null;
  }

  function placePendingImageAt(px, py) {
    const p = toPdfPoint(px, py);
    const dims = state.pendingPlacement;
    const w = dims.wPt, h = dims.hPt;
    pushHistory();
    currentPage().annotations.push({
      id: uid(), type: "image", x: p.x - w / 2, y: p.y - h / 2, w, h, dataURL: dims.dataURL,
    });
    renderOverlayBoxes();
    state.pendingPlacement = null;
    setTool(state.mode === "sign" ? null : state.tool);
    updateInteractCursor();
    setStatus("");
  }

  function updateInteractCursor() {
    const layer = $("#interactLayer");
    const active = getActiveTool();
    layer.className = "interact-layer" + (active ? " catching" : "");
  }

  // ---------------- Rail (thumbnails) ----------------

  async function renderRail() {
    const list = $("#railList");
    list.innerHTML = "";
    for (let i = 0; i < state.pages.length; i++) {
      list.appendChild(await buildThumb(i));
    }
    highlightCurrentThumb();
  }

  async function buildThumb(index) {
    const pg = state.pages[index];
    const el = document.createElement("div");
    el.className = "thumb" + (state.selectPages ? " select-mode" : "");
    el.draggable = true;
    el.dataset.index = String(index);
    el.dataset.id = pg.id;

    const wrap = document.createElement("div");
    wrap.className = "thumb-canvas-wrap";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    el.appendChild(wrap);

    const disp = pageDisplaySize(pg);
    const scale = 150 / disp.w;
    const rot = ((pg.baseRotation + pg.userRotation) % 360 + 360) % 360;
    canvas.width = disp.w * scale; canvas.height = disp.h * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (pg.kind === "pdf") {
      try {
        const src = state.sources[pg.sourceId];
        const page = await src.pdfjsDoc.getPage(pg.sourcePageIndex + 1);
        const vp = page.getViewport({ scale, rotation: rot });
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch (e) { /* ignore render errors for thumbs */ }
    } else {
      const src = state.sources[pg.sourceId];
      const img = await loadedImageEl(src.dataURL);
      const MARGIN = 6;
      const s = Math.min((canvas.width - MARGIN * 2) / img.naturalWidth, (canvas.height - MARGIN * 2) / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    }

    const num = document.createElement("div");
    num.className = "thumb-num"; num.textContent = String(index + 1);
    wrap.appendChild(num);

    const check = document.createElement("input");
    check.type = "checkbox"; check.className = "thumb-check";
    check.checked = state.selectedPageIds.has(pg.id);
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) state.selectedPageIds.add(pg.id); else state.selectedPageIds.delete(pg.id);
      updateSelectBar();
    });
    wrap.appendChild(check);

    const tools = document.createElement("div");
    tools.className = "thumb-tools";
    tools.appendChild(thumbToolBtn("↻", "Rotate", pg.kind !== "image", () => rotatePage(index, 90)));
    tools.appendChild(thumbToolBtn("⎘", "Duplicate", true, () => duplicatePage(index)));
    tools.appendChild(thumbToolBtn("✕", "Delete", true, () => deletePage(index)));
    wrap.appendChild(tools);

    el.addEventListener("click", () => {
      if (state.selectPages) { check.checked = !check.checked; check.dispatchEvent(new Event("change")); return; }
      state.currentIndex = index; renderCurrentPage(); highlightCurrentThumb();
    });

    el.addEventListener("dragstart", (e) => { el.classList.add("dragging"); e.dataTransfer.setData("text/plain", String(index)); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("dragover"); });
    el.addEventListener("dragleave", () => el.classList.remove("dragover"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("dragover");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = index;
      if (Number.isNaN(from) || from === to) return;
      pushHistory();
      const [moved] = state.pages.splice(from, 1);
      state.pages.splice(to > from ? to - 1 : to, 0, moved);
      const wasCurrentId = state.pages[state.currentIndex] ? state.pages[state.currentIndex].id : null;
      renderRail();
      if (wasCurrentId) state.currentIndex = state.pages.findIndex((p) => p.id === wasCurrentId);
      updateModeAvailability();
    });

    return el;
  }

  function thumbToolBtn(glyph, title, enabled, onClick) {
    const b = document.createElement("button");
    b.className = "thumb-tool-btn"; b.title = title; b.textContent = glyph;
    b.style.fontSize = "11px";
    if (!enabled) { b.style.opacity = "0.3"; b.style.pointerEvents = "none"; }
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function highlightCurrentThumb() {
    $$(".thumb").forEach((t) => t.classList.toggle("current", parseInt(t.dataset.index, 10) === state.currentIndex));
  }

  function rotatePage(index, delta) {
    pushHistory();
    const pg = state.pages[index];
    pg.userRotation = ((pg.userRotation + delta) % 360 + 360) % 360;
    renderRail();
    if (index === state.currentIndex) renderCurrentPage();
  }

  function duplicatePage(index) {
    pushHistory();
    const pg = state.pages[index];
    const copy = JSON.parse(JSON.stringify(pg));
    copy.id = uid();
    copy.annotations.forEach((a) => (a.id = uid()));
    state.pages.splice(index + 1, 0, copy);
    renderRail(); updateModeAvailability();
  }

  function deletePage(index) {
    pushHistory();
    state.pages.splice(index, 1);
    if (state.currentIndex >= state.pages.length) state.currentIndex = state.pages.length - 1;
    renderRail(); renderCurrentPage(); updateModeAvailability();
    $("#exportBtn").disabled = state.pages.length === 0;
  }

  function updateSelectBar() {
    $("#selectBar").style.display = state.selectPages ? "flex" : "none";
    $("#addPagesBtn").style.display = state.selectPages ? "none" : "flex";
  }

  async function extractSelected() {
    const ids = state.selectedPageIds;
    if (!ids.size) { toast("Select at least one page", "err"); return; }
    const indices = state.pages.map((p, i) => i).filter((i) => ids.has(state.pages[i].id));
    const bytes = await buildOutputDoc(indices);
    await triggerDownload(bytes, "extracted.pdf");
  }

  function deleteSelected() {
    const ids = state.selectedPageIds;
    if (!ids.size) return;
    pushHistory();
    state.pages = state.pages.filter((p) => !ids.has(p.id));
    state.selectedPageIds.clear();
    if (state.currentIndex >= state.pages.length) state.currentIndex = state.pages.length - 1;
    renderRail(); renderCurrentPage(); updateModeAvailability();
    $("#exportBtn").disabled = state.pages.length === 0;
  }

  // ---------------- Export ----------------

  async function buildOutputDoc(indices) {
    const outDoc = await PDFDocument.create();
    const font = await outDoc.embedFont(StandardFonts.Helvetica);
    const libDocCache = {};
    const idxList = indices || state.pages.map((_, i) => i);
    for (const i of idxList) {
      const pg = state.pages[i];
      let outPage;
      if (pg.kind === "pdf") {
        if (!libDocCache[pg.sourceId]) {
          libDocCache[pg.sourceId] = await PDFDocument.load(state.sources[pg.sourceId].bytes);
        }
        const libDoc = libDocCache[pg.sourceId];
        const [copied] = await outDoc.copyPages(libDoc, [pg.sourcePageIndex]);
        outDoc.addPage(copied);
        outPage = copied;
      } else {
        const src = state.sources[pg.sourceId];
        const img = pg && src.mime === "image/png" ? await outDoc.embedPng(src.bytes) : await outDoc.embedJpg(src.bytes);
        outPage = outDoc.addPage([pg.widthPt, pg.heightPt]);
        const MARGIN = 36;
        const availW = pg.widthPt - MARGIN * 2, availH = pg.heightPt - MARGIN * 2;
        const s = Math.min(availW / img.width, availH / img.height, 1);
        const dw = img.width * s, dh = img.height * s;
        outPage.drawImage(img, { x: (pg.widthPt - dw) / 2, y: (pg.heightPt - dh) / 2, width: dw, height: dh });
      }
      const totalRotation = ((pg.baseRotation + pg.userRotation) % 360 + 360) % 360;
      outPage.setRotation(degrees(totalRotation));
      await drawAnnotations(outDoc, outPage, pg, font);
    }
    return outDoc.save();
  }

  async function drawAnnotations(outDoc, page, pg, font) {
    for (const a of pg.annotations) {
      try {
        if (a.type === "highlight") {
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: hexToPdfColor(a.color), opacity: 0.35 });
        } else if (a.type === "whiteout") {
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(1, 1, 1) });
        } else if (a.type === "draw") {
          for (let i = 1; i < a.points.length; i++) {
            page.drawLine({ start: a.points[i - 1], end: a.points[i], thickness: a.strokeWidth, color: hexToPdfColor(a.color) });
          }
        } else if (a.type === "text") {
          const lines = (a.text || "").split("\n");
          const top = a.y + a.h;
          lines.forEach((line, i) => {
            if (!line) return;
            page.drawText(line, { x: a.x + 2, y: top - a.fontSize * 1.05 - i * a.fontSize * 1.25, size: a.fontSize, font, color: hexToPdfColor(a.color) });
          });
        } else if (a.type === "image") {
          const mime = a.dataURL.startsWith("data:image/png") ? "png" : "jpg";
          const bytes = dataURLToBytes(a.dataURL);
          const img = mime === "png" ? await outDoc.embedPng(bytes) : await outDoc.embedJpg(bytes);
          page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h });
        }
      } catch (e) { console.error("annotation draw failed", a, e); }
    }
  }

  function dataURLToBytes(dataURL) {
    const b64 = dataURL.split(",")[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function exportDocument() {
    if (!state.pages.length) return;
    setStatus("Building PDF…");
    try {
      const bytes = await buildOutputDoc();
      const name = (state.docLabel || "document").replace(/\.pdf$/i, "") + "-edited.pdf";
      await triggerDownload(bytes, name);
    } catch (e) {
      console.error(e);
      toast("Export failed: " + e.message, "err");
    } finally { setStatus(""); }
  }

  // ---------------- Forms ----------------

  function isFormsEligible() {
    const ids = Object.keys(state.sources);
    if (ids.length !== 1) return false;
    const src = state.sources[ids[0]];
    if (src.kind !== "pdf") return false;
    if (state.pages.length !== src.numPages) return false;
    return state.pages.every((p, i) => p.sourceId === src.id && p.sourcePageIndex === i);
  }

  function mapWidgetsToPages(libDoc) {
    const map = new Map();
    libDoc.getPages().forEach((page, pageIndex) => {
      let annots;
      try { annots = page.node.Annots ? page.node.Annots() : null; } catch (e) { annots = null; }
      if (!annots) return;
      for (let i = 0; i < annots.size(); i++) {
        try {
          const ref = annots.get(i);
          const dict = libDoc.context.lookup(ref);
          map.set(dict, pageIndex);
        } catch (e) { /* ignore */ }
      }
    });
    return map;
  }

  async function enterFormsMode() {
    if (!isFormsEligible()) { state.formsFields = []; return; }
    const ids = Object.keys(state.sources);
    const src = state.sources[ids[0]];
    if (state.formsSourceId !== src.id || !state.formsDoc) {
      state.formsDoc = await PDFDocument.load(src.bytes);
      state.formsSourceId = src.id;
      const form = state.formsDoc.getForm();
      const widgetPageMap = mapWidgetsToPages(state.formsDoc);
      const fields = form.getFields();
      state.formsFields = fields.map((f) => describeField(f, widgetPageMap));
    }
  }

  function describeField(f, widgetPageMap) {
    const name = f.getName();
    let type = "unsupported", options = [];
    if (f instanceof PDFLib.PDFTextField) type = "text";
    else if (f instanceof PDFLib.PDFCheckBox) type = "checkbox";
    else if (f instanceof PDFLib.PDFRadioGroup) { type = "radio"; options = f.getOptions(); }
    else if (f instanceof PDFLib.PDFDropdown) { type = "dropdown"; options = f.getOptions(); }
    else if (f instanceof PDFLib.PDFOptionList) { type = "optionlist"; options = f.getOptions(); }
    let widgets = [];
    try {
      widgets = f.acroField.getWidgets().map((w) => {
        const r = w.getRectangle();
        const pageIndex = widgetPageMap.get(w.dict);
        return { rect: r, pageIndex };
      });
    } catch (e) { widgets = []; }
    return { name, type, field: f, options, widgets };
  }

  function renderFormsOverlay() {
    $$(".field-input, .field-checkbox").forEach((el) => el.remove());
    if (!currentPage() || currentPage().kind !== "pdf") return;
    const layer = $("#interactLayer");
    for (const fd of state.formsFields) {
      if (fd.type !== "text" && fd.type !== "checkbox") continue;
      for (const w of fd.widgets) {
        if (w.pageIndex !== state.currentIndex) continue;
        const p1 = toScreenPoint(w.rect.x, w.rect.y + w.rect.height);
        const p2 = toScreenPoint(w.rect.x + w.rect.width, w.rect.y);
        const left = Math.min(p1.x, p2.x), top = Math.min(p1.y, p2.y);
        const width = Math.abs(p2.x - p1.x), height = Math.abs(p2.y - p1.y);
        if (fd.type === "text") {
          const input = document.createElement("textarea");
          input.className = "field-input";
          input.style.left = left + "px"; input.style.top = top + "px";
          input.style.width = width + "px"; input.style.height = height + "px";
          input.style.resize = "none";
          input.style.fontSize = Math.max(9, Math.min(14, height * 0.6)) + "px";
          input.value = safeCall(() => fd.field.getText(), "") || "";
          input.addEventListener("input", () => {
            safeCall(() => fd.field.setText(input.value));
            syncFormsPanelValue(fd.name, input.value);
          });
          layer.appendChild(input);
        } else if (fd.type === "checkbox") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.className = "field-checkbox";
          input.style.left = left + "px"; input.style.top = top + "px";
          input.style.width = Math.max(14, width) + "px"; input.style.height = Math.max(14, height) + "px";
          input.checked = safeCall(() => fd.field.isChecked(), false);
          input.addEventListener("change", () => {
            safeCall(() => (input.checked ? fd.field.check() : fd.field.uncheck()));
            syncFormsPanelValue(fd.name, input.checked);
          });
          layer.appendChild(input);
        }
      }
    }
  }

  function safeCall(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function syncFormsPanelValue(name, value) {
    const el = document.querySelector('[data-field-name="' + CSS.escape(name) + '"]');
    if (!el) return;
    if (el.type === "checkbox") el.checked = value; else el.value = value;
  }

  async function exportFilledForm() {
    if (!state.formsDoc) return;
    try {
      const font = await state.formsDoc.embedFont(StandardFonts.Helvetica);
      const formPages = state.formsDoc.getPages();
      for (let i = 0; i < state.pages.length; i++) {
        const pg = state.pages[i];
        if (!formPages[i]) continue;
        if (pg.annotations.length) await drawAnnotations(state.formsDoc, formPages[i], pg, font);
        const totalRotation = ((pg.baseRotation + pg.userRotation) % 360 + 360) % 360;
        formPages[i].setRotation(degrees(totalRotation));
      }
      if (state.flattenForms) state.formsDoc.getForm().flatten();
      const bytes = await state.formsDoc.save();
      await triggerDownload(bytes, (state.docLabel || "form").replace(/\.pdf$/i, "") + "-filled.pdf");
    } catch (e) {
      console.error(e);
      toast("Couldn't export form: " + e.message, "err");
    }
  }

  // ---------------- Signature ----------------

  function setupSigPad() {
    const canvas = $("#sigPad");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    function resize() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * 2; canvas.height = rect.height * 2;
      ctx.scale(2, 2); ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#16202B";
    }
    resize();
    let drawing = false, last = null;
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true; const r = canvas.getBoundingClientRect();
      last = { x: e.clientX - r.left, y: e.clientY - r.top };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer to capture */ }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const r = canvas.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    });
    window.addEventListener("pointerup", () => { drawing = false; });
    $("#sigClear").addEventListener("click", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); });
  }

  function canvasHasInk(canvas) {
    try {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) { if (data[i] !== 0) return true; }
      return false;
    } catch (e) { return true; }
  }

  async function getSignatureDataURL() {
    if (state.sigMode === "draw") {
      const canvas = $("#sigPad");
      return canvas.toDataURL("image/png");
    } else {
      const text = $("#sigTypeInput").value.trim() || "Your name";
      const off = document.createElement("canvas");
      off.width = 600; off.height = 180;
      const ctx = off.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, off.width, off.height);
      ctx.fillStyle = "#16202B";
      ctx.font = "italic 600 64px 'Fraunces', Georgia, serif";
      ctx.textBaseline = "middle"; ctx.textAlign = "center";
      ctx.fillText(text, off.width / 2, off.height / 2);
      return off.toDataURL("image/png");
    }
  }

  async function startPlaceSignature() {
    if (state.sigMode === "draw" && !canvasHasInk($("#sigPad"))) {
      toast("Draw your signature first", "err");
      return;
    }
    if (state.sigMode === "type" && !$("#sigTypeInput").value.trim()) {
      toast("Type your name first", "err");
      return;
    }
    const dataURL = await getSignatureDataURL();
    const dims = await loadImageDims(dataURL);
    const targetW = 160;
    const targetH = targetW * (dims.h / dims.w);
    state.pendingPlacement = { dataURL, wPt: targetW, hPt: targetH };
    state.tool = "place-sig";
    updateInteractCursor();
    setStatus("Click on the page to place your signature");
  }

  // ---------------- UI wiring ----------------

  const MODES = [
    { id: "view", label: "View", icon: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z M12 15a3 3 0 100-6 3 3 0 000 6z" },
    { id: "annotate", label: "Annotate", icon: "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" },
    { id: "edit", label: "Edit", icon: "M4 21h4l11-11a2.83 2.83 0 00-4-4L4 17v4z" },
    { id: "pages", label: "Pages", icon: "M4 4h11l5 5v11a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" },
    { id: "forms", label: "Forms", icon: "M4 7V5a1 1 0 011-1h3M4 17v2a1 1 0 001 1h3m9-14h3a1 1 0 011 1v2m-1 11h-3M9 9h6v6H9z" },
    { id: "sign", label: "Sign", icon: "M3 17l6 1 9-9-4-4-9 9 1 6z" },
  ];

  function buildModeTabs() {
    const el = $("#modeTabs");
    el.innerHTML = "";
    MODES.forEach((m) => {
      const b = document.createElement("button");
      b.className = "mode-tab"; b.dataset.mode = m.id; b.setAttribute("role", "tab");
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + m.icon + '"/></svg><span class="label">' + m.label + "</span>";
      b.addEventListener("click", () => setMode(m.id));
      el.appendChild(b);
    });
  }

  function updateModeAvailability() {
    const formsOk = isFormsEligible();
    $$('.mode-tab[data-mode="forms"]').forEach((b) => {
      b.disabled = !formsOk;
      b.title = formsOk ? "" : "Available for a single, unmodified PDF form";
    });
  }

  async function setMode(mode) {
    state.mode = mode;
    state.tool = mode === "annotate" ? "highlight" : mode === "edit" ? "text" : null;
    $$(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    if (mode === "forms") await enterFormsMode();
    renderPanel();
    updateInteractCursor();
    if (currentPage()) await renderCurrentPage();
    if (window.innerWidth <= 880) { $("#panel").classList.remove("open"); $("#rail").classList.remove("open"); }
  }

  function setTool(tool) {
    state.tool = tool;
    renderPanel();
    updateInteractCursor();
  }

  function renderPanel() {
    const panel = $("#panel");
    panel.innerHTML = "";
    if (!currentPage() && state.mode !== "forms") {
      panel.innerHTML = '<div class="panel-section"><p class="hint">Open a file to start editing.</p></div>';
      return;
    }
    if (state.mode === "view") panel.appendChild(sectionViewHelp());
    if (state.mode === "annotate") panel.appendChild(sectionAnnotate());
    if (state.mode === "edit") panel.appendChild(sectionEdit());
    if (state.mode === "pages") panel.appendChild(sectionPages());
    if (state.mode === "forms") panel.appendChild(sectionForms());
    if (state.mode === "sign") panel.appendChild(sectionSign());
  }

  function el(tag, cls, content, isText) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (content !== undefined) { if (isText) e.textContent = content; else e.innerHTML = content; }
    return e;
  }

  function selectedAnnotation() {
    if (!state.selectedAnnoId || !currentPage()) return null;
    return currentPage().annotations.find((x) => x.id === state.selectedAnnoId) || null;
  }

  const COLORABLE_TYPES = ["highlight", "draw", "text"];

  function swatchRow(onPick) {
    const row = el("div", "swatches");
    const selected = selectedAnnotation();
    const activeColor = (selected && COLORABLE_TYPES.includes(selected.type)) ? selected.color : state.color;
    COLORS.forEach((c) => {
      const s = document.createElement("button");
      s.className = "swatch" + (activeColor === c ? " active" : "");
      s.style.background = c;
      s.addEventListener("click", () => {
        state.color = c;
        const a = selectedAnnotation();
        if (a && COLORABLE_TYPES.includes(a.type)) {
          pushHistory();
          a.color = c;
          renderOverlayBoxes(); redrawMarks(); selectAnno(a.id);
        }
        onPick(); renderPanel();
      });
      row.appendChild(s);
    });
    return row;
  }

  const FONT_SIZE_MIN = 6, FONT_SIZE_MAX = 200;

  function fontSizeRow() {
    const row = el("div", "range-row");
    const range = document.createElement("input");
    range.type = "range"; range.min = String(FONT_SIZE_MIN); range.max = "42"; range.value = String(state.fontSize);
    const number = document.createElement("input");
    number.type = "number"; number.min = String(FONT_SIZE_MIN); number.max = String(FONT_SIZE_MAX); number.step = "1";
    number.value = String(state.fontSize);

    let historyPushed = false;
    function apply(size) {
      state.fontSize = size;
      range.value = String(Math.min(size, 42));
      number.value = String(size);
      const a = selectedAnnotation();
      if (a && a.type === "text") {
        if (!historyPushed) { pushHistory(); historyPushed = true; }
        a.fontSize = size; renderOverlayBoxes(); selectAnno(a.id);
      }
    }
    range.addEventListener("pointerdown", () => { historyPushed = false; });
    range.addEventListener("input", () => apply(parseInt(range.value, 10)));
    number.addEventListener("focus", () => { historyPushed = false; });
    number.addEventListener("input", () => {
      const v = parseInt(number.value, 10);
      if (!Number.isNaN(v)) apply(Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, v)));
    });
    number.addEventListener("blur", () => { number.value = String(state.fontSize); });

    row.appendChild(range); row.appendChild(number);
    return row;
  }

  function sectionViewHelp() {
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "About this page"));
    const pg = currentPage();
    sec.appendChild(el("div", "hint",
      "Format: " + (pg.kind === "pdf" ? "PDF page" : "Converted image") +
      "<br>Size: " + Math.round(pg.widthPt) + " × " + Math.round(pg.heightPt) + " pt" +
      (pg.annotations.length ? "<br>" + pg.annotations.length + " annotation(s)" : "")));
    sec.appendChild(el("div", "hint", "Switch to <b>Annotate</b>, <b>Edit</b>, <b>Forms</b> or <b>Sign</b> above to start editing this page."));
    return sec;
  }

  function toolGridBtn(label, iconPath, active, onClick) {
    const b = document.createElement("button");
    b.className = active ? "active" : "";
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + iconPath + '"/></svg><span>' + label + "</span>";
    b.addEventListener("click", onClick);
    return b;
  }

  function sectionAnnotate() {
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "Tool"));
    const grid = el("div", "tool-grid");
    grid.appendChild(toolGridBtn("Highlight", "M9 11l3 3L22 4 M2 12h.01", state.tool === "highlight", () => setTool("highlight")));
    grid.appendChild(toolGridBtn("Draw", "M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586 M11 11a1 1 0 102 2 1 1 0 00-2-2z", state.tool === "draw", () => setTool("draw")));
    grid.appendChild(toolGridBtn("Sticky text", "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z", state.tool === "text", () => setTool("text")));
    sec.appendChild(grid);
    const sec2 = el("div", "panel-section");
    sec2.appendChild(el("h3", "", "Color"));
    sec2.appendChild(swatchRow(() => {}));
    if (state.tool === "draw") {
      sec2.appendChild(el("h3", "", "Stroke width"));
      const row = el("div", "range-row");
      const input = document.createElement("input");
      input.type = "range"; input.min = "1"; input.max = "14"; input.value = String(state.strokeWidth);
      input.addEventListener("input", () => { state.strokeWidth = parseInt(input.value, 10); });
      row.appendChild(input);
      sec2.appendChild(row);
    }
    if (state.tool === "text") {
      sec2.appendChild(el("h3", "", "Font size"));
      sec2.appendChild(fontSizeRow());
    }
    const wrap = el("div"); wrap.appendChild(sec); wrap.appendChild(sec2);
    return wrap;
  }

  function sectionEdit() {
    const wrap = el("div");
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "Edit tool"));
    const grid = el("div", "tool-grid");
    grid.appendChild(toolGridBtn("Mask", "M3 3h18v18H3z", state.tool === "mask", () => setTool("mask")));
    grid.appendChild(toolGridBtn("Add text", "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z", state.tool === "text", () => setTool("text")));
    grid.appendChild(toolGridBtn("Replace image", "M3 3h18v18H3z M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M21 15l-5-5L5 21", state.tool === "image", () => triggerImagePlacement()));
    sec.appendChild(grid);
    sec.appendChild(el("div", "hint", "<b>Mask</b> covers existing text or images with a white box. Then use <b>Add text</b> to type the replacement on top."));
    wrap.appendChild(sec);
    const sec2 = el("div", "panel-section");
    sec2.appendChild(el("h3", "", "Color"));
    sec2.appendChild(swatchRow(() => {}));
    if (state.tool === "text") {
      sec2.appendChild(el("h3", "", "Font size"));
      sec2.appendChild(fontSizeRow());
    }
    wrap.appendChild(sec2);
    return wrap;
  }

  function triggerImagePlacement() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/jpeg,image/png";
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const mime = guessMime(file);
      const bytes = await fileToBytes(file);
      const dataURL = bytesToDataURL(bytes, mime);
      const dims = await loadImageDims(dataURL);
      const targetW = 180, targetH = targetW * (dims.h / dims.w);
      state.pendingPlacement = { dataURL, wPt: targetW, hPt: targetH };
      state.tool = "image";
      updateInteractCursor();
      setStatus("Click on the page to place the image");
    });
    input.click();
  }

  function sectionPages() {
    const wrap = el("div");
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "Page actions"));
    const stack = el("div", "stack");
    stack.appendChild(stackBtn("Rotate left 90°", () => rotatePage(state.currentIndex, -90)));
    stack.appendChild(stackBtn("Rotate right 90°", () => rotatePage(state.currentIndex, 90)));
    stack.appendChild(stackBtn("Duplicate this page", () => duplicatePage(state.currentIndex)));
    stack.appendChild(stackBtn("Delete this page", () => deletePage(state.currentIndex)));
    stack.appendChild(stackBtn("Insert blank page after", () => insertBlankPage(state.currentIndex)));
    sec.appendChild(stack);
    wrap.appendChild(sec);
    const sec2 = el("div", "panel-section");
    sec2.appendChild(el("h3", "", "Multiple pages"));
    sec2.appendChild(el("div", "hint", "Tap the checkmark icon above the page list to select several pages, then extract them as a new PDF or delete them."));
    wrap.appendChild(sec2);
    return wrap;
  }

  function stackBtn(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function insertBlankPage(index) {
    pushHistory();
    const ref = state.pages[index] || state.pages[0];
    const pg = { id: uid(), kind: "image", sourceId: "_blank_img", sourcePageIndex: 0, baseRotation: 0, userRotation: 0, widthPt: ref ? ref.widthPt : 612, heightPt: ref ? ref.heightPt : 792, annotations: [] };
    if (!state.sources["_blank_img"]) {
      const off = document.createElement("canvas"); off.width = 4; off.height = 4;
      const ctx = off.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 4, 4);
      state.sources["_blank_img"] = { id: "_blank_img", kind: "image", mime: "image/png", dataURL: off.toDataURL("image/png"), w: 1, h: 1, bytes: dataURLToBytes(off.toDataURL("image/png")) };
    }
    state.pages.splice(index + 1, 0, pg);
    renderRail(); updateModeAvailability();
  }

  function sectionForms() {
    const wrap = el("div");
    if (!isFormsEligible()) {
      const sec = el("div", "panel-section");
      sec.appendChild(el("h3", "", "Fill & Sign"));
      sec.appendChild(el("div", "hint", "Forms works on a single, unmodified PDF loaded on its own. Open just the form PDF (no merged pages or reordering) to fill its fields here."));
      wrap.appendChild(sec);
      return wrap;
    }
    if (!state.formsFields.length) {
      const sec = el("div", "panel-section");
      sec.appendChild(el("h3", "", "Fill & Sign"));
      sec.appendChild(el("div", "hint", "No fillable form fields were found in this PDF."));
      wrap.appendChild(sec);
      return wrap;
    }
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "Form fields (" + state.formsFields.length + ")"));
    state.formsFields.forEach((fd) => sec.appendChild(fieldRow(fd)));
    wrap.appendChild(sec);
    const sec2 = el("div", "panel-section");
    const row = el("div", "field-row");
    const label = document.createElement("label"); label.textContent = "Flatten on export";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = state.flattenForms;
    cb.addEventListener("change", () => { state.flattenForms = cb.checked; });
    row.appendChild(label); row.appendChild(cb);
    sec2.appendChild(row);
    sec2.appendChild(el("div", "hint", "Flattening makes filled values permanent (no longer editable) and matches how the form will look everywhere it's opened."));
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-primary"; exportBtn.style.width = "100%"; exportBtn.style.justifyContent = "center"; exportBtn.style.marginTop = "10px";
    exportBtn.textContent = "Export filled PDF";
    exportBtn.addEventListener("click", exportFilledForm);
    sec2.appendChild(exportBtn);
    wrap.appendChild(sec2);
    return wrap;
  }

  function fieldRow(fd) {
    const row = el("div", "field-list-item");
    row.appendChild(el("div", "fname", fd.name, true));
    if (fd.type === "text") {
      const input = document.createElement("textarea");
      input.rows = 1; input.dataset.fieldName = fd.name;
      input.value = safeCall(() => fd.field.getText(), "") || "";
      input.addEventListener("input", () => {
        safeCall(() => fd.field.setText(input.value));
        renderFormsOverlay();
      });
      row.appendChild(input);
    } else if (fd.type === "checkbox") {
      const label = el("label", "radio-opt");
      const input = document.createElement("input");
      input.type = "checkbox"; input.dataset.fieldName = fd.name;
      input.checked = safeCall(() => fd.field.isChecked(), false);
      input.addEventListener("change", () => {
        safeCall(() => (input.checked ? fd.field.check() : fd.field.uncheck()));
        renderFormsOverlay();
      });
      label.appendChild(input); label.appendChild(document.createTextNode("Checked"));
      row.appendChild(label);
    } else if (fd.type === "radio") {
      const current = safeCall(() => fd.field.getSelected(), null);
      fd.options.forEach((opt) => {
        const label = el("label", "radio-opt");
        const input = document.createElement("input");
        input.type = "radio"; input.name = "radio_" + fd.name; input.value = opt;
        input.checked = current === opt;
        input.addEventListener("change", () => safeCall(() => fd.field.select(opt)));
        label.appendChild(input); label.appendChild(document.createTextNode(opt));
        row.appendChild(label);
      });
    } else if (fd.type === "dropdown") {
      const select = document.createElement("select");
      const current = safeCall(() => fd.field.getSelected(), []);
      fd.options.forEach((opt) => {
        const o = document.createElement("option"); o.value = opt; o.textContent = opt;
        if (current && current.indexOf(opt) >= 0) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener("change", () => safeCall(() => fd.field.select(select.value)));
      row.appendChild(select);
    } else if (fd.type === "optionlist") {
      const select = document.createElement("select"); select.multiple = true;
      const current = safeCall(() => fd.field.getSelected(), []);
      fd.options.forEach((opt) => {
        const o = document.createElement("option"); o.value = opt; o.textContent = opt;
        if (current && current.indexOf(opt) >= 0) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener("change", () => {
        const chosen = Array.from(select.selectedOptions).map((o) => o.value);
        safeCall(() => fd.field.select(chosen));
      });
      row.appendChild(select);
    } else {
      row.appendChild(el("div", "hint", "Not editable here (button or signature field)."));
    }
    return row;
  }

  function sectionSign() {
    const wrap = el("div");
    const sec = el("div", "panel-section");
    sec.appendChild(el("h3", "", "Your signature"));
    const tabs = el("div", "sig-tabs");
    const drawTab = document.createElement("button"); drawTab.textContent = "Draw"; drawTab.className = state.sigMode === "draw" ? "active" : "";
    const typeTab = document.createElement("button"); typeTab.textContent = "Type"; typeTab.className = state.sigMode === "type" ? "active" : "";
    drawTab.addEventListener("click", () => { state.sigMode = "draw"; renderPanel(); });
    typeTab.addEventListener("click", () => { state.sigMode = "type"; renderPanel(); });
    tabs.appendChild(drawTab); tabs.appendChild(typeTab);
    sec.appendChild(tabs);

    if (state.sigMode === "draw") {
      const padWrap = el("div", "sig-pad-wrap");
      const canvas = document.createElement("canvas"); canvas.id = "sigPad";
      padWrap.appendChild(canvas);
      sec.appendChild(padWrap);
      const clearBtn = document.createElement("button");
      clearBtn.className = "btn btn-ghost"; clearBtn.id = "sigClear"; clearBtn.style.width = "100%"; clearBtn.style.justifyContent = "center"; clearBtn.style.marginTop = "8px";
      clearBtn.textContent = "Clear";
      sec.appendChild(clearBtn);
      setTimeout(setupSigPad, 0);
    } else {
      const input = document.createElement("input");
      input.id = "sigTypeInput"; input.type = "text"; input.placeholder = "Type your name";
      sec.appendChild(input);
    }

    const placeBtn = document.createElement("button");
    placeBtn.className = "btn btn-primary"; placeBtn.style.width = "100%"; placeBtn.style.justifyContent = "center"; placeBtn.style.marginTop = "10px";
    placeBtn.textContent = "Place signature on page";
    placeBtn.addEventListener("click", startPlaceSignature);
    sec.appendChild(placeBtn);
    sec.appendChild(el("div", "hint", "After placing, drag to move or use the corner handle to resize. Click elsewhere to deselect."));
    wrap.appendChild(sec);
    return wrap;
  }

  // ---------------- Boot / global events ----------------

  function wireGlobal() {
    buildModeTabs();
    setupInteractLayer();

    $("#addFilesBtn").addEventListener("click", () => $("#fileInput").click());
    $("#addPagesBtn").addEventListener("click", () => $("#fileInput").click());
    $("#emptyOpenBtn").addEventListener("click", () => $("#fileInput").click());
    $("#emptyImagesBtn").addEventListener("click", () => $("#imageInput").click());
    $("#fileInput").addEventListener("change", (e) => addFiles(e.target.files));
    $("#imageInput").addEventListener("change", (e) => addFiles(e.target.files));

    const dz = $("#dropzone");
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("hover"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("hover"); }));
    dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      if (e.target.closest(".dropzone")) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    $("#exportBtn").addEventListener("click", exportDocument);

    $("#zoomIn").addEventListener("click", () => { state.fitMode = "custom"; state.zoom = Math.min(4, state.zoom * 1.2); renderCurrentPage(); });
    $("#zoomOut").addEventListener("click", () => { state.fitMode = "custom"; state.zoom = Math.max(0.15, state.zoom / 1.2); renderCurrentPage(); });
    $("#zoomFit").addEventListener("click", () => { state.fitMode = "width"; renderCurrentPage(); });

    $("#selectModeBtn").addEventListener("click", () => {
      state.selectPages = !state.selectPages;
      state.selectedPageIds.clear();
      renderRail(); updateSelectBar();
    });
    $("#extractBtn").addEventListener("click", extractSelected);
    $("#deleteSelBtn").addEventListener("click", deleteSelected);

    $("#railToggle").addEventListener("click", () => $("#rail").classList.toggle("open"));
    $("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("open"));

    $("#undoBtn").addEventListener("click", undo);
    $("#redoBtn").addEventListener("click", redo);

    window.addEventListener("keydown", (e) => {
      const typing = isTypingTarget(document.activeElement);

      if ((e.metaKey || e.ctrlKey) && !typing) {
        const key = e.key.toLowerCase();
        if (key === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
        if (key === "z") { e.preventDefault(); undo(); return; }
        if (key === "y") { e.preventDefault(); redo(); return; }
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (state.selectedAnnoId && typing) return;
        if (state.selectedAnnoId) {
          const pg = currentPage();
          if (pg) {
            pushHistory();
            pg.annotations = pg.annotations.filter((a) => a.id !== state.selectedAnnoId);
            state.selectedAnnoId = null;
            renderOverlayBoxes(); redrawMarks();
          }
        }
      }
      if (e.key === "Escape") { selectAnno(null); }
    });

    window.addEventListener("resize", () => { if (state.fitMode === "width") renderCurrentPage(); });

    setMode("view");
    updateModeAvailability();
  }

  document.addEventListener("DOMContentLoaded", wireGlobal);
})();
