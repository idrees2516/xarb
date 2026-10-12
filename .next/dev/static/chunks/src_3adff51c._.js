(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/lib/xarb.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DEFAULT_SETTINGS",
    ()=>DEFAULT_SETTINGS,
    "chartBuf",
    ()=>chartBuf,
    "clearSavedSettings",
    ()=>clearSavedSettings,
    "connectEngine",
    ()=>connectEngine,
    "fmtCents",
    ()=>fmtCents,
    "fmtClock",
    ()=>fmtClock,
    "fmtCountdown",
    ()=>fmtCountdown,
    "fmtPnl",
    ()=>fmtPnl,
    "fmtPrice",
    ()=>fmtPrice,
    "fmtSigned",
    ()=>fmtSigned,
    "fmtUs",
    ()=>fmtUs,
    "liveRef",
    ()=>liveRef,
    "sendControl",
    ()=>sendControl,
    "setFocusMarket",
    ()=>setFocusMarket,
    "toggleMarket",
    ()=>toggleMarket,
    "updateSettings",
    ()=>updateSettings,
    "useXarb",
    ()=>useXarb
]);
// ─── XARB client library (v0.5): types, live buffers, store, socket ────────────
// Multi-market universe: every panel follows the FOCUS market; the universe
// grid shows all 11 series. Settings persist to localStorage and re-apply to
// the engine on (re)connect so restarts never lose the operator's config.
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zustand$2f$esm$2f$react$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/zustand/esm/react.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$2f$build$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/socket.io-client/build/esm/index.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/sonner/dist/index.mjs [app-client] (ecmascript)");
'use client';
;
;
;
const DEFAULT_SETTINGS = {
    autoTrade: true,
    stakeUsd: 25,
    jumpThreshC: 20,
    fvFloorC: 60,
    edgeThreshC: 10,
    minSecsLeft: 45,
    maxTradesPerWindow: 1,
    model: 'cdf',
    takerFeeBps: 0,
    maxBookAgeMs: 3000,
    markets: {
        'btc-5m': true,
        'eth-5m': true,
        'sol-5m': true,
        'xrp-5m': true,
        'doge-5m': true,
        'bnb-5m': true,
        'hype-5m': true,
        'btc-15m': true,
        'eth-15m': true,
        'sol-15m': true,
        'xrp-15m': true
    },
    focusMarket: 'btc-5m',
    sideDown: true,
    sigmaAuto: true,
    sigmaWImp: 0.65,
    sigmaZGate: 0.35,
    sigmaFloorK: 0.75,
    sigmaAbsFloor: 6,
    hedgeOn: true,
    hedgeRatio: 0.5,
    hedgeFeeBps: 4.5,
    hedgeMinBandUsd: 170,
    hedgeWinddownS: 20,
    minNetEdgeC: 1.5,
    exitBandC: 2,
    minCaptureC: 5
};
const chartBuf = [];
const liveRef = {
    snap: null
};
const useXarb = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zustand$2f$esm$2f$react$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["create"])((set)=>({
        connected: false,
        snapshot: null,
        signals: [],
        trades: [],
        settings: {
            ...DEFAULT_SETTINGS,
            markets: {
                ...DEFAULT_SETTINGS.markets
            }
        }
    }));
// ── settings persistence (survive engine restarts) ───────────────────────────
const LS_KEY = 'xarb.settings.v05';
function loadSaved() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw);
        return j && typeof j === 'object' ? j : null;
    } catch  {
        return null;
    }
}
function saveSettings(s) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch  {
    /* best-effort */ }
}
function clearSavedSettings() {
    try {
        localStorage.removeItem(LS_KEY);
    } catch  {
    /* noop */ }
}
// ── socket ───────────────────────────────────────────────────────────────────
let socket = null;
let appliedSaved = false;
function connectEngine() {
    if (socket) return socket;
    // 3011: the engine runs as a supervised clean child process
    socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$2f$build$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["io"])('/?XTransformPort=3011', {
        transports: [
            'websocket',
            'polling'
        ],
        forceNew: true,
        reconnection: true,
        reconnectionDelay: 1000,
        timeout: 10000
    });
    socket.on('connect', ()=>{
        appliedSaved = false;
        useXarb.setState({
            connected: true
        });
    });
    socket.on('disconnect', ()=>useXarb.setState({
            connected: false
        }));
    socket.on('init', (d)=>{
        chartBuf.length = 0;
        for (const p of d.history ?? [])chartBuf.push(p);
        liveRef.snap = d.snapshot;
        useXarb.setState({
            snapshot: d.snapshot,
            signals: d.signals ?? [],
            trades: d.trades ?? [],
            settings: d.settings ?? {
                ...DEFAULT_SETTINGS
            }
        });
        // re-apply the operator's persisted settings once per connection so an
        // engine restart never silently reverts the terminal to defaults
        if (!appliedSaved) {
            appliedSaved = true;
            const saved = loadSaved();
            if (saved && Object.keys(saved).length) {
                const merged = {
                    ...d.settings ?? DEFAULT_SETTINGS,
                    ...saved
                };
                useXarb.setState({
                    settings: merged
                });
                saveSettings(merged);
                socket?.emit('control', {
                    type: 'settings',
                    settings: saved
                });
            }
        }
    });
    socket.on('snap', (s)=>{
        liveRef.snap = s;
        useXarb.setState({
            snapshot: s
        });
        const pt = s.chart;
        if (pt && pt.t > (chartBuf[chartBuf.length - 1]?.t ?? 0)) {
            chartBuf.push(pt);
            if (chartBuf.length > 1600) chartBuf.shift();
        }
    });
    socket.on('signal', (sig)=>{
        useXarb.setState((st)=>({
                signals: [
                    sig,
                    ...st.signals
                ].slice(0, 60)
            }));
        if (sig.action === 'EXECUTED' && sig.fillPrice != null) {
            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success(`BUY ${sig.marketLabel} ${sig.side} @ ${sig.fillPrice.toFixed(1)}¢`, {
                description: `edge +${(sig.edge ?? 0).toFixed(1)}¢ · net +${(sig.netEdgeC ?? 0).toFixed(1)}¢ · jump ${sig.jump5s.toFixed(1)}¢ · ${Math.round(sig.shares ?? 0)} sh · $${sig.stake ?? 0}`
            });
        } else if (sig.action === 'EXIT') {
            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success(`EARLY EXIT · ${sig.marketLabel} ${sig.side} @ ${sig.fillPrice?.toFixed(1) ?? '—'}¢`, {
                description: sig.reason ?? ''
            });
        }
    });
    socket.on('hedge', (e)=>{
        const short = e.qtyBtc < 0;
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"])(short ? `HEDGE · SHORT ${e.asset} (${e.marketLabel})` : `HEDGE · BUY ${e.asset} (${e.marketLabel})`, {
            description: `${e.qtyBtc} ${e.asset} @ ${e.px.toFixed(e.px > 100 ? 1 : 4)} · ${e.reason} · pos ${e.posQtyBtc} · ${e.feeUsd.toFixed(3)} fee`
        });
    });
    socket.on('settle', (t)=>{
        useXarb.setState((st)=>({
                trades: st.trades.map((x)=>x.id === t.id ? t : x)
            }));
        const hedgeNote = t.hedgePnlUsd != null ? ` · hedge ${t.hedgePnlUsd >= 0 ? '+' : ''}${t.hedgePnlUsd.toFixed(2)}` : '';
        if (t.status === 'WON') {
            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success(`${t.marketLabel} ${t.side} settled WON +$${(t.pnlUsd ?? 0).toFixed(2)}`, {
                description: `final ${t.finalPrice?.toFixed(2)} vs strike ${t.strike.toFixed(2)}${hedgeNote}`
            });
        } else if (t.status === 'LOST') {
            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error(`${t.marketLabel} ${t.side} settled LOST $${Math.abs(t.pnlUsd ?? 0).toFixed(2)}`, {
                description: `final ${t.finalPrice?.toFixed(2)} vs strike ${t.strike.toFixed(2)}${hedgeNote}`
            });
        }
    });
    return socket;
}
function sendControl(msg) {
    socket?.emit('control', msg);
}
function updateSettings(patch) {
    useXarb.setState((st)=>{
        const merged = {
            ...st.settings,
            ...patch
        };
        saveSettings(merged);
        return {
            settings: merged
        };
    });
    sendControl({
        type: 'settings',
        settings: patch
    });
}
function setFocusMarket(id) {
    updateSettings({
        focusMarket: id
    });
}
function toggleMarket(id, on) {
    useXarb.setState((st)=>{
        const merged = {
            ...st.settings,
            markets: {
                ...st.settings.markets,
                [id]: on
            }
        };
        saveSettings(merged);
        return {
            settings: merged
        };
    });
    sendControl({
        type: 'settings',
        settings: {
            markets: {
                [id]: on
            }
        }
    });
}
function fmtPrice(p, d = 2) {
    if (p == null || !Number.isFinite(p)) return '—';
    return p.toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
    });
}
function fmtCents(c, d = 1) {
    if (c == null || !Number.isFinite(c)) return '—';
    return `${c.toFixed(d)}¢`;
}
function fmtPnl(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}
function fmtClock(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', {
        hour12: false
    });
}
function fmtCountdown(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtUs(us) {
    if (!Number.isFinite(us) || us <= 0) return '—';
    if (us < 1000) return `${us.toFixed(0)}µs`;
    return `${(us / 1000).toFixed(2)}ms`;
}
function fmtSigned(v, d = 1) {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/utils.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cn",
    ()=>cn
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/clsx/dist/clsx.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-client] (ecmascript)");
;
;
function cn(...inputs) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/sheet.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Sheet",
    ()=>Sheet,
    "SheetClose",
    ()=>SheetClose,
    "SheetContent",
    ()=>SheetContent,
    "SheetDescription",
    ()=>SheetDescription,
    "SheetFooter",
    ()=>SheetFooter,
    "SheetHeader",
    ()=>SheetHeader,
    "SheetTitle",
    ()=>SheetTitle,
    "SheetTrigger",
    ()=>SheetTrigger
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-dialog/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$x$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__XIcon$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/x.js [app-client] (ecmascript) <export default as XIcon>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
"use client";
;
;
;
;
function Sheet({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "sheet",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 10,
        columnNumber: 10
    }, this);
}
_c = Sheet;
function SheetTrigger({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trigger"], {
        "data-slot": "sheet-trigger",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 16,
        columnNumber: 10
    }, this);
}
_c1 = SheetTrigger;
function SheetClose({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Close"], {
        "data-slot": "sheet-close",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 22,
        columnNumber: 10
    }, this);
}
_c2 = SheetClose;
function SheetPortal({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Portal"], {
        "data-slot": "sheet-portal",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 28,
        columnNumber: 10
    }, this);
}
_c3 = SheetPortal;
function SheetOverlay({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Overlay"], {
        "data-slot": "sheet-overlay",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 36,
        columnNumber: 5
    }, this);
}
_c4 = SheetOverlay;
function SheetContent({ className, children, side = "right", ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SheetPortal, {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SheetOverlay, {}, void 0, false, {
                fileName: "[project]/src/components/ui/sheet.tsx",
                lineNumber: 57,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Content"], {
                "data-slot": "sheet-content",
                className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500", side === "right" && "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm", side === "left" && "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm", side === "top" && "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b", side === "bottom" && "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t", className),
                ...props,
                children: [
                    children,
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Close"], {
                        className: "ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$x$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__XIcon$3e$__["XIcon"], {
                                className: "size-4"
                            }, void 0, false, {
                                fileName: "[project]/src/components/ui/sheet.tsx",
                                lineNumber: 76,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "sr-only",
                                children: "Close"
                            }, void 0, false, {
                                fileName: "[project]/src/components/ui/sheet.tsx",
                                lineNumber: 77,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/ui/sheet.tsx",
                        lineNumber: 75,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/ui/sheet.tsx",
                lineNumber: 58,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 56,
        columnNumber: 5
    }, this);
}
_c5 = SheetContent;
function SheetHeader({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        "data-slot": "sheet-header",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("flex flex-col gap-1.5 p-4", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 86,
        columnNumber: 5
    }, this);
}
_c6 = SheetHeader;
function SheetFooter({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        "data-slot": "sheet-footer",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("mt-auto flex flex-col gap-2 p-4", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 96,
        columnNumber: 5
    }, this);
}
_c7 = SheetFooter;
function SheetTitle({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Title"], {
        "data-slot": "sheet-title",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("text-foreground font-semibold", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 109,
        columnNumber: 5
    }, this);
}
_c8 = SheetTitle;
function SheetDescription({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$dialog$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Description"], {
        "data-slot": "sheet-description",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("text-muted-foreground text-sm", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/sheet.tsx",
        lineNumber: 122,
        columnNumber: 5
    }, this);
}
_c9 = SheetDescription;
;
var _c, _c1, _c2, _c3, _c4, _c5, _c6, _c7, _c8, _c9;
__turbopack_context__.k.register(_c, "Sheet");
__turbopack_context__.k.register(_c1, "SheetTrigger");
__turbopack_context__.k.register(_c2, "SheetClose");
__turbopack_context__.k.register(_c3, "SheetPortal");
__turbopack_context__.k.register(_c4, "SheetOverlay");
__turbopack_context__.k.register(_c5, "SheetContent");
__turbopack_context__.k.register(_c6, "SheetHeader");
__turbopack_context__.k.register(_c7, "SheetFooter");
__turbopack_context__.k.register(_c8, "SheetTitle");
__turbopack_context__.k.register(_c9, "SheetDescription");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/switch.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Switch",
    ()=>Switch
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$switch$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-switch/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
"use client";
;
;
;
function Switch({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$switch$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "switch",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50", className),
        ...props,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$switch$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Thumb"], {
            "data-slot": "switch-thumb",
            className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0")
        }, void 0, false, {
            fileName: "[project]/src/components/ui/switch.tsx",
            lineNumber: 21,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/ui/switch.tsx",
        lineNumber: 13,
        columnNumber: 5
    }, this);
}
_c = Switch;
;
var _c;
__turbopack_context__.k.register(_c, "Switch");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/slider.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Slider",
    ()=>Slider
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slider$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-slider/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
function Slider({ className, defaultValue, value, min = 0, max = 100, ...props }) {
    _s();
    const _values = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "Slider.useMemo[_values]": ()=>Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [
                min,
                max
            ]
    }["Slider.useMemo[_values]"], [
        value,
        defaultValue,
        min,
        max
    ]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slider$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "slider",
        defaultValue: defaultValue,
        value: value,
        min: min,
        max: max,
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col", className),
        ...props,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slider$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Track"], {
                "data-slot": "slider-track",
                className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"),
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slider$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Range"], {
                    "data-slot": "slider-range",
                    className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full")
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/slider.tsx",
                    lineNumber: 45,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/ui/slider.tsx",
                lineNumber: 39,
                columnNumber: 7
            }, this),
            Array.from({
                length: _values.length
            }, (_, index)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slider$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Thumb"], {
                    "data-slot": "slider-thumb",
                    className: "border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
                }, index, false, {
                    fileName: "[project]/src/components/ui/slider.tsx",
                    lineNumber: 53,
                    columnNumber: 9
                }, this))
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/slider.tsx",
        lineNumber: 27,
        columnNumber: 5
    }, this);
}
_s(Slider, "g0y/PG/feYg861SE8jxuAUMRVc0=");
_c = Slider;
;
var _c;
__turbopack_context__.k.register(_c, "Slider");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/input.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Input",
    ()=>Input
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
;
;
function Input({ className, type, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
        type: type,
        "data-slot": "input",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm", "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]", "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/input.tsx",
        lineNumber: 7,
        columnNumber: 5
    }, this);
}
_c = Input;
;
var _c;
__turbopack_context__.k.register(_c, "Input");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/button.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Button",
    ()=>Button,
    "buttonVariants",
    ()=>buttonVariants
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-slot/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/class-variance-authority/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
;
;
;
;
const buttonVariants = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cva"])("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive", {
    variants: {
        variant: {
            default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
            destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
            outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
            secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
            ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
            link: "text-primary underline-offset-4 hover:underline"
        },
        size: {
            default: "h-9 px-4 py-2 has-[>svg]:px-3",
            sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
            lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
            icon: "size-9"
        }
    },
    defaultVariants: {
        variant: "default",
        size: "default"
    }
});
function Button({ className, variant, size, asChild = false, ...props }) {
    const Comp = asChild ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slot"] : "button";
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Comp, {
        "data-slot": "button",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])(buttonVariants({
            variant,
            size,
            className
        })),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/button.tsx",
        lineNumber: 51,
        columnNumber: 5
    }, this);
}
_c = Button;
;
var _c;
__turbopack_context__.k.register(_c, "Button");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/select.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Select",
    ()=>Select,
    "SelectContent",
    ()=>SelectContent,
    "SelectGroup",
    ()=>SelectGroup,
    "SelectItem",
    ()=>SelectItem,
    "SelectLabel",
    ()=>SelectLabel,
    "SelectScrollDownButton",
    ()=>SelectScrollDownButton,
    "SelectScrollUpButton",
    ()=>SelectScrollUpButton,
    "SelectSeparator",
    ()=>SelectSeparator,
    "SelectTrigger",
    ()=>SelectTrigger,
    "SelectValue",
    ()=>SelectValue
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-select/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$check$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__CheckIcon$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/check.js [app-client] (ecmascript) <export default as CheckIcon>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$chevron$2d$down$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ChevronDownIcon$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/chevron-down.js [app-client] (ecmascript) <export default as ChevronDownIcon>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$chevron$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ChevronUpIcon$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/chevron-up.js [app-client] (ecmascript) <export default as ChevronUpIcon>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
"use client";
;
;
;
;
function Select({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "select",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 12,
        columnNumber: 10
    }, this);
}
_c = Select;
function SelectGroup({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Group"], {
        "data-slot": "select-group",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 18,
        columnNumber: 10
    }, this);
}
_c1 = SelectGroup;
function SelectValue({ ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Value"], {
        "data-slot": "select-value",
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 24,
        columnNumber: 10
    }, this);
}
_c2 = SelectValue;
function SelectTrigger({ className, size = "default", children, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trigger"], {
        "data-slot": "select-trigger",
        "data-size": size,
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
        ...props,
        children: [
            children,
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Icon"], {
                asChild: true,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$chevron$2d$down$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ChevronDownIcon$3e$__["ChevronDownIcon"], {
                    className: "size-4 opacity-50"
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/select.tsx",
                    lineNumber: 47,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/ui/select.tsx",
                lineNumber: 46,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 36,
        columnNumber: 5
    }, this);
}
_c3 = SelectTrigger;
function SelectContent({ className, children, position = "popper", ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Portal"], {
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Content"], {
            "data-slot": "select-content",
            className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md", position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1", className),
            position: position,
            ...props,
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SelectScrollUpButton, {}, void 0, false, {
                    fileName: "[project]/src/components/ui/select.tsx",
                    lineNumber: 72,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Viewport"], {
                    className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("p-1", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"),
                    children: children
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/select.tsx",
                    lineNumber: 73,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SelectScrollDownButton, {}, void 0, false, {
                    fileName: "[project]/src/components/ui/select.tsx",
                    lineNumber: 82,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/components/ui/select.tsx",
            lineNumber: 61,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 60,
        columnNumber: 5
    }, this);
}
_c4 = SelectContent;
function SelectLabel({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Label"], {
        "data-slot": "select-label",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("text-muted-foreground px-2 py-1.5 text-xs", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 93,
        columnNumber: 5
    }, this);
}
_c5 = SelectLabel;
function SelectItem({ className, children, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Item"], {
        "data-slot": "select-item",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2", className),
        ...props,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "absolute right-2 flex size-3.5 items-center justify-center",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ItemIndicator"], {
                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$check$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__CheckIcon$3e$__["CheckIcon"], {
                        className: "size-4"
                    }, void 0, false, {
                        fileName: "[project]/src/components/ui/select.tsx",
                        lineNumber: 117,
                        columnNumber: 11
                    }, this)
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/select.tsx",
                    lineNumber: 116,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/ui/select.tsx",
                lineNumber: 115,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ItemText"], {
                children: children
            }, void 0, false, {
                fileName: "[project]/src/components/ui/select.tsx",
                lineNumber: 120,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 107,
        columnNumber: 5
    }, this);
}
_c6 = SelectItem;
function SelectSeparator({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
        "data-slot": "select-separator",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-border pointer-events-none -mx-1 my-1 h-px", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 130,
        columnNumber: 5
    }, this);
}
_c7 = SelectSeparator;
function SelectScrollUpButton({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ScrollUpButton"], {
        "data-slot": "select-scroll-up-button",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("flex cursor-default items-center justify-center py-1", className),
        ...props,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$chevron$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ChevronUpIcon$3e$__["ChevronUpIcon"], {
            className: "size-4"
        }, void 0, false, {
            fileName: "[project]/src/components/ui/select.tsx",
            lineNumber: 151,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 143,
        columnNumber: 5
    }, this);
}
_c8 = SelectScrollUpButton;
function SelectScrollDownButton({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$select$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ScrollDownButton"], {
        "data-slot": "select-scroll-down-button",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("flex cursor-default items-center justify-center py-1", className),
        ...props,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$chevron$2d$down$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ChevronDownIcon$3e$__["ChevronDownIcon"], {
            className: "size-4"
        }, void 0, false, {
            fileName: "[project]/src/components/ui/select.tsx",
            lineNumber: 169,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/ui/select.tsx",
        lineNumber: 161,
        columnNumber: 5
    }, this);
}
_c9 = SelectScrollDownButton;
;
var _c, _c1, _c2, _c3, _c4, _c5, _c6, _c7, _c8, _c9;
__turbopack_context__.k.register(_c, "Select");
__turbopack_context__.k.register(_c1, "SelectGroup");
__turbopack_context__.k.register(_c2, "SelectValue");
__turbopack_context__.k.register(_c3, "SelectTrigger");
__turbopack_context__.k.register(_c4, "SelectContent");
__turbopack_context__.k.register(_c5, "SelectLabel");
__turbopack_context__.k.register(_c6, "SelectItem");
__turbopack_context__.k.register(_c7, "SelectSeparator");
__turbopack_context__.k.register(_c8, "SelectScrollUpButton");
__turbopack_context__.k.register(_c9, "SelectScrollDownButton");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/label.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Label",
    ()=>Label
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$label$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-label/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
"use client";
;
;
;
function Label({ className, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$label$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "label",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/label.tsx",
        lineNumber: 13,
        columnNumber: 5
    }, this);
}
_c = Label;
;
var _c;
__turbopack_context__.k.register(_c, "Label");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/separator.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Separator",
    ()=>Separator
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$separator$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-separator/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
"use client";
;
;
;
function Separator({ className, orientation = "horizontal", decorative = true, ...props }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$separator$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Root"], {
        "data-slot": "separator",
        decorative: decorative,
        orientation: orientation,
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])("bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className),
        ...props
    }, void 0, false, {
        fileName: "[project]/src/components/ui/separator.tsx",
        lineNumber: 15,
        columnNumber: 5
    }, this);
}
_c = Separator;
;
var _c;
__turbopack_context__.k.register(_c, "Separator");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/settings-sheet.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "SettingsSheet",
    ()=>SettingsSheet
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/sheet.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$switch$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/switch.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/slider.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$input$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/input.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/button.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/select.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$label$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/label.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/separator.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
;
;
function SettingRow({ label, hint, children }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "space-y-1.5",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-baseline justify-between",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$label$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Label"], {
                        className: "text-xs text-zinc-300",
                        children: label
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                        lineNumber: 38,
                        columnNumber: 9
                    }, this),
                    hint ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-[10px] text-zinc-600",
                        children: hint
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                        lineNumber: 39,
                        columnNumber: 17
                    }, this) : null
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                lineNumber: 37,
                columnNumber: 7
            }, this),
            children
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
        lineNumber: 36,
        columnNumber: 5
    }, this);
}
_c = SettingRow;
/** The 11-series universe (mirrors the engine registry). */ const UNIVERSE_IDS = [
    {
        id: 'btc-5m',
        label: 'BTC',
        group: '5-minute series'
    },
    {
        id: 'eth-5m',
        label: 'ETH',
        group: '5-minute series'
    },
    {
        id: 'sol-5m',
        label: 'SOL',
        group: '5-minute series'
    },
    {
        id: 'xrp-5m',
        label: 'XRP',
        group: '5-minute series'
    },
    {
        id: 'doge-5m',
        label: 'DOGE',
        group: '5-minute series'
    },
    {
        id: 'bnb-5m',
        label: 'BNB',
        group: '5-minute series'
    },
    {
        id: 'hype-5m',
        label: 'HYPE',
        group: '5-minute series'
    },
    {
        id: 'btc-15m',
        label: 'BTC',
        group: '15-minute series'
    },
    {
        id: 'eth-15m',
        label: 'ETH',
        group: '15-minute series'
    },
    {
        id: 'sol-15m',
        label: 'SOL',
        group: '15-minute series'
    },
    {
        id: 'xrp-15m',
        label: 'XRP',
        group: '15-minute series'
    }
];
function SettingsSheet({ trigger }) {
    _s();
    const settings = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "SettingsSheet.useXarb[settings]": (s)=>s.settings
    }["SettingsSheet.useXarb[settings]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "SettingsSheet.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["SettingsSheet.useXarb[marketsLive]"]);
    const setAllMarkets = (on)=>{
        const patch = {};
        for (const u of UNIVERSE_IDS)patch[u.id] = on;
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
            markets: {
                ...settings.markets,
                ...patch
            }
        });
    };
    const restoreDefaults = ()=>{
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["clearSavedSettings"])();
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
            ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DEFAULT_SETTINGS"],
            markets: {
                ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DEFAULT_SETTINGS"].markets
            }
        });
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Sheet"], {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SheetTrigger"], {
                asChild: true,
                children: trigger
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                lineNumber: 78,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SheetContent"], {
                side: "right",
                className: "w-[340px] overflow-y-auto border-[#22262e] bg-[#0d1014] sm:w-[400px]",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SheetHeader"], {
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SheetTitle"], {
                                className: "text-zinc-100",
                                children: "Strategy parameters"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 81,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SheetDescription"], {
                                className: "text-xs text-zinc-500",
                                children: "Applied to the engine live over the socket — no restart. Persisted locally, re-applied on reconnect."
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 82,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                        lineNumber: 80,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "space-y-5 px-4 pb-8",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "text-[10px] font-semibold uppercase tracking-widest text-cyan-400/80",
                                children: [
                                    "Market universe · ",
                                    marketsLive,
                                    "/11 live"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 89,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Focus market",
                                hint: "detail panels + charts follow",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Select"], {
                                    value: settings.focusMarket,
                                    onValueChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["setFocusMarket"])(v),
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectTrigger"], {
                                            className: "border-[#262b33] bg-[#12151b] text-zinc-200",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectValue"], {}, void 0, false, {
                                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                lineNumber: 96,
                                                columnNumber: 17
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 95,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectContent"], {
                                            className: "border-[#262b33] bg-[#12151b] text-zinc-200",
                                            children: UNIVERSE_IDS.map((u)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectItem"], {
                                                    value: u.id,
                                                    children: [
                                                        u.label,
                                                        " · ",
                                                        u.group === '5-minute series' ? '5m' : '15m',
                                                        settings.markets[u.id] ? '' : ' (off)'
                                                    ]
                                                }, u.id, true, {
                                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                    lineNumber: 100,
                                                    columnNumber: 19
                                                }, this))
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 98,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 94,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 93,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "DOWN-side capture",
                                hint: "mirrored trigger set on the DOWN token",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$switch$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Switch"], {
                                            checked: settings.sideDown,
                                            onCheckedChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                                    sideDown: v
                                                })
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 111,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `text-xs ${settings.sideDown ? 'text-red-300' : 'text-zinc-500'}`,
                                            children: settings.sideDown ? 'BOTH SIDES — fires UP and DOWN' : 'UP side only (DOWN shown, no firing)'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 112,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 110,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 109,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Series enabled",
                                hint: "toggle any series live",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "grid grid-cols-4 gap-1.5",
                                        children: UNIVERSE_IDS.map((u)=>{
                                            const on = settings.markets[u.id] ?? false;
                                            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                onClick: ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toggleMarket"])(u.id, !on),
                                                title: `${u.label} ${u.group === '5-minute series' ? '5m' : '15m'} — ${on ? 'click to disable' : 'click to enable'}`,
                                                className: `rounded border px-2 py-1.5 text-[10px] font-bold tracking-wide transition-colors ${on ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' : 'border-[#262b33] bg-[#12151b] text-zinc-600 hover:bg-[#1a1e25]'}`,
                                                children: [
                                                    u.label,
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "ms-0.5 font-normal text-[8px] opacity-70",
                                                        children: u.group === '5-minute series' ? '5m' : '15m'
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                        lineNumber: 134,
                                                        columnNumber: 21
                                                    }, this)
                                                ]
                                            }, u.id, true, {
                                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                lineNumber: 123,
                                                columnNumber: 19
                                            }, this);
                                        })
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                        lineNumber: 119,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "mt-1.5 flex gap-2",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                                                variant: "outline",
                                                size: "sm",
                                                className: "h-7 flex-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300 hover:bg-emerald-500/20",
                                                onClick: ()=>setAllMarkets(true),
                                                children: "Enable all"
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                lineNumber: 142,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                                                variant: "outline",
                                                size: "sm",
                                                className: "h-7 flex-1 border-red-500/30 bg-red-500/10 text-[10px] text-red-300 hover:bg-red-500/20",
                                                onClick: ()=>setAllMarkets(false),
                                                children: "Disable all"
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                lineNumber: 150,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                        lineNumber: 141,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 118,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 161,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Auto-trade (paper)",
                                hint: "fire fills when triggers align",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$switch$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Switch"], {
                                            checked: settings.autoTrade,
                                            onCheckedChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                                    autoTrade: v
                                                })
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 165,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `text-xs ${settings.autoTrade ? 'text-emerald-400' : 'text-zinc-500'}`,
                                            children: settings.autoTrade ? 'ARMED' : 'observe only'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 166,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 164,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 163,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Stake per trade",
                                hint: "$ paper",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$input$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Input"], {
                                    type: "number",
                                    min: 5,
                                    max: 500,
                                    step: 5,
                                    value: settings.stakeUsd,
                                    onChange: (e)=>{
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v) && v >= 5 && v <= 500) (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            stakeUsd: v
                                        });
                                    },
                                    className: "border-[#262b33] bg-[#12151b] font-mono text-zinc-200"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 173,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 172,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "FV model",
                                hint: "fair-value curve",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Select"], {
                                    value: settings.model,
                                    onValueChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            model: v
                                        }),
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectTrigger"], {
                                            className: "border-[#262b33] bg-[#12151b] text-zinc-200",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectValue"], {}, void 0, false, {
                                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                lineNumber: 190,
                                                columnNumber: 17
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 189,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectContent"], {
                                            className: "border-[#262b33] bg-[#12151b] text-zinc-200",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectItem"], {
                                                    value: "cdf",
                                                    children: "Normal CDF — Φ(z) · honest tails"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                    lineNumber: 193,
                                                    columnNumber: 17
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$select$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectItem"], {
                                                    value: "linear",
                                                    children: "Linear — legacy spec (52 + slope·(S−K))"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                                    lineNumber: 194,
                                                    columnNumber: 17
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 192,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 188,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 187,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 199,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "text-[10px] font-semibold uppercase tracking-widest text-emerald-400/80",
                                children: "Trigger thresholds (both sides)"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 201,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "① 5s FV jump trigger",
                                hint: `${settings.jumpThreshC}¢`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.jumpThreshC
                                    ],
                                    min: 5,
                                    max: 40,
                                    step: 1,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            jumpThreshC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 206,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 205,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "② FV floor",
                                hint: `${settings.fvFloorC}¢`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.fvFloorC
                                    ],
                                    min: 40,
                                    max: 80,
                                    step: 1,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            fvFloorC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 216,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 215,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "③ Minimum edge vs ask",
                                hint: `${settings.edgeThreshC}¢`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.edgeThreshC
                                    ],
                                    min: 5,
                                    max: 30,
                                    step: 1,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            edgeThreshC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 226,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 225,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Min seconds left to enter",
                                hint: `${settings.minSecsLeft}s`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.minSecsLeft
                                    ],
                                    min: 10,
                                    max: 120,
                                    step: 5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            minSecsLeft: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 236,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 235,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Max trades per window",
                                hint: `${settings.maxTradesPerWindow} / market`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.maxTradesPerWindow
                                    ],
                                    min: 1,
                                    max: 5,
                                    step: 1,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            maxTradesPerWindow: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 246,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 245,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Taker fee assumption",
                                hint: `${settings.takerFeeBps} bps`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.takerFeeBps
                                    ],
                                    min: 0,
                                    max: 300,
                                    step: 10,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            takerFeeBps: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 256,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 255,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Max book age for entry",
                                hint: `${settings.maxBookAgeMs}ms`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.maxBookAgeMs
                                    ],
                                    min: 1000,
                                    max: 10000,
                                    step: 500,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            maxBookAgeMs: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 266,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 265,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 275,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "text-[10px] font-semibold uppercase tracking-widest text-cyan-400/80",
                                children: "σ auto-calibration (live PM · per market)"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 278,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Auto-calibrate σ",
                                hint: "implied inversion from PM mids",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$switch$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Switch"], {
                                            checked: settings.sigmaAuto,
                                            onCheckedChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                                    sigmaAuto: v
                                                })
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 284,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `text-xs ${settings.sigmaAuto ? 'text-cyan-400' : 'text-zinc-500'}`,
                                            children: settings.sigmaAuto ? 'AUTO — snap tracks PM' : 'legacy fixed floor'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 285,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 283,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 282,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Implied weight in blend",
                                hint: `w_imp ${settings.sigmaWImp.toFixed(2)}`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.sigmaWImp
                                    ],
                                    min: 0,
                                    max: 1,
                                    step: 0.05,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            sigmaWImp: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 292,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 291,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Identifiability gate |Φ⁻¹(mid)|",
                                hint: settings.sigmaZGate.toFixed(2),
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.sigmaZGate
                                    ],
                                    min: 0.1,
                                    max: 1,
                                    step: 0.05,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            sigmaZGate: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 302,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 301,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Dynamic floor k × median(σ_imp)",
                                hint: `k ${settings.sigmaFloorK.toFixed(2)}`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.sigmaFloorK
                                    ],
                                    min: 0.1,
                                    max: 1.5,
                                    step: 0.05,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            sigmaFloorK: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 312,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 311,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Absolute σ floor",
                                hint: `${settings.sigmaAbsFloor.toFixed(1)} pts/√s (BTC-scale · relative)`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.sigmaAbsFloor
                                    ],
                                    min: 3,
                                    max: 30,
                                    step: 0.5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            sigmaAbsFloor: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 322,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 321,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 331,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "text-[10px] font-semibold uppercase tracking-widest text-fuchsia-400/80",
                                children: "δ-hedging (Binance · per market symbol)"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 334,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Delta-hedge binary exposure",
                                hint: "W–W band policy",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$switch$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Switch"], {
                                            checked: settings.hedgeOn,
                                            onCheckedChange: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                                    hedgeOn: v
                                                })
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 340,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `text-xs ${settings.hedgeOn ? 'text-fuchsia-400' : 'text-zinc-500'}`,
                                            children: settings.hedgeOn ? 'HEDGED — shorts Δ on Binance' : 'directional (unhedged)'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                            lineNumber: 341,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 339,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 338,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Hedge ratio (Δ fraction)",
                                hint: `${(settings.hedgeRatio * 100).toFixed(0)}% of delta`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.hedgeRatio
                                    ],
                                    min: 0,
                                    max: 1,
                                    step: 0.05,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            hedgeRatio: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 348,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 347,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Binance taker fee",
                                hint: `${settings.hedgeFeeBps.toFixed(1)} bps`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.hedgeFeeBps
                                    ],
                                    min: 0,
                                    max: 100,
                                    step: 0.5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            hedgeFeeBps: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 358,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 357,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Minimum hedge band",
                                hint: `$${settings.hedgeMinBandUsd.toFixed(0)} notional`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.hedgeMinBandUsd
                                    ],
                                    min: 20,
                                    max: 800,
                                    step: 10,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            hedgeMinBandUsd: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 368,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 367,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Wind-down horizon",
                                hint: `${settings.hedgeWinddownS}s before close`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.hedgeWinddownS
                                    ],
                                    min: 5,
                                    max: 60,
                                    step: 5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            hedgeWinddownS: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 378,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 377,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 387,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "text-[10px] font-semibold uppercase tracking-widest text-emerald-400/80",
                                children: "Profitability & capture"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 390,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "④ Min net edge to fire",
                                hint: `${settings.minNetEdgeC.toFixed(1)}¢ after fees + hedge`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.minNetEdgeC
                                    ],
                                    min: 0,
                                    max: 20,
                                    step: 0.5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            minNetEdgeC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 395,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 394,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Early-exit band (PM bid vs FV)",
                                hint: `${settings.exitBandC.toFixed(1)}¢`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.exitBandC
                                    ],
                                    min: 0,
                                    max: 15,
                                    step: 0.5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            exitBandC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 405,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 404,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SettingRow, {
                                label: "Min captured edge to exit",
                                hint: `${settings.minCaptureC.toFixed(1)}¢/sh`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$slider$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slider"], {
                                    value: [
                                        settings.minCaptureC
                                    ],
                                    min: 0,
                                    max: 20,
                                    step: 0.5,
                                    onValueCommit: (v)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["updateSettings"])({
                                            minCaptureC: v[0]
                                        })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                    lineNumber: 415,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 414,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$separator$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Separator"], {
                                className: "bg-[#1e222a]"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 424,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                                        variant: "outline",
                                        className: "flex-1 border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300",
                                        onClick: ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sendControl"])({
                                                type: 'reset'
                                            }),
                                        children: "Reset stats"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                        lineNumber: 427,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                                        variant: "outline",
                                        className: "flex-1 border-[#262b33] bg-[#12151b] text-zinc-300 hover:bg-[#1a1e25]",
                                        onClick: ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sendControl"])({
                                                type: 'stop'
                                            }),
                                        children: "Stop engine"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                        lineNumber: 434,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 426,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                                variant: "outline",
                                className: "w-full border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20",
                                onClick: restoreDefaults,
                                children: "Restore default settings"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 442,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "text-[10px] leading-relaxed text-zinc-600",
                                children: "Paper execution fills by walking the live CLOB ask ladder of the side that fired. Real execution requires your own Polymarket API credentials (EIP-712 signing) deployed locally next to the matching engine."
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                                lineNumber: 450,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                        lineNumber: 87,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/settings-sheet.tsx",
                lineNumber: 79,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/settings-sheet.tsx",
        lineNumber: 77,
        columnNumber: 5
    }, this);
}
_s(SettingsSheet, "fO4vgWlSNhL2zyhlT8VDxSDbOEc=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c1 = SettingsSheet;
var _c, _c1;
__turbopack_context__.k.register(_c, "SettingRow");
__turbopack_context__.k.register(_c1, "SettingsSheet");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/header.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Header",
    ()=>Header
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$zap$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Zap$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/zap.js [app-client] (ecmascript) <export default as Zap>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2d$2$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings2$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/settings-2.js [app-client] (ecmascript) <export default as Settings2>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$play$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Play$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/play.js [app-client] (ecmascript) <export default as Play>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$square$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Square$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/square.js [app-client] (ecmascript) <export default as Square>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$radio$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Radio$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/radio.js [app-client] (ecmascript) <export default as Radio>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$settings$2d$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/settings-sheet.tsx [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
function statusColor(s) {
    if (s === 'live') return 'bg-emerald-400';
    if (s === 'connecting') return 'bg-amber-400';
    if (s === 'degraded') return 'bg-amber-400';
    return 'bg-red-500';
}
function FeedBadge({ label, status, extra }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: "inline-flex items-center gap-1.5 rounded-md border border-[#262b33] bg-[#12151b] px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-300",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: `h-1.5 w-1.5 rounded-full ${statusColor(status)} ${status === 'live' ? 'animate-pulse' : ''}`
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/header.tsx",
                lineNumber: 18,
                columnNumber: 7
            }, this),
            label,
            extra ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "font-mono text-zinc-500",
                children: extra
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/header.tsx",
                lineNumber: 20,
                columnNumber: 16
            }, this) : null
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/header.tsx",
        lineNumber: 17,
        columnNumber: 5
    }, this);
}
_c = FeedBadge;
function Header() {
    _s();
    const connected = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[connected]": (s)=>s.connected
    }["Header.useXarb[connected]"]);
    const binStatus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[binStatus]": (s)=>s.snapshot?.feeds.binance.status ?? 'connecting'
    }["Header.useXarb[binStatus]"]);
    const binLat = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[binLat]": (s)=>s.snapshot?.feeds.binance.latencyMs ?? 0
    }["Header.useXarb[binLat]"]);
    const pmStatus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[pmStatus]": (s)=>s.snapshot?.feeds.polymarket.status ?? 'connecting'
    }["Header.useXarb[pmStatus]"]);
    const running = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[running]": (s)=>s.snapshot?.running ?? false
    }["Header.useXarb[running]"]);
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[focus]": (s)=>s.snapshot?.focus
    }["Header.useXarb[focus]"]);
    const secsLeft = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[secsLeft]": (s)=>s.snapshot?.window.secondsLeft ?? 0
    }["Header.useXarb[secsLeft]"]);
    const strike = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[strike]": (s)=>s.snapshot?.window.strike ?? null
    }["Header.useXarb[strike]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["Header.useXarb[marketsLive]"]);
    const marketsTotal = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[marketsTotal]": (s)=>s.snapshot?.marketsTotal ?? 0
    }["Header.useXarb[marketsTotal]"]);
    const sigmaAuto = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[sigmaAuto]": (s)=>s.snapshot?.sigma.auto ?? true
    }["Header.useXarb[sigmaAuto]"]);
    const hedgeOn = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[hedgeOn]": (s)=>s.snapshot?.hedge.on ?? false
    }["Header.useXarb[hedgeOn]"]);
    const hedgeActive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[hedgeActive]": (s)=>s.snapshot?.hedge.active ?? false
    }["Header.useXarb[hedgeActive]"]);
    const sideDown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Header.useXarb[sideDown]": (s)=>s.snapshot?.sideDown ?? true
    }["Header.useXarb[sideDown]"]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("header", {
        className: "sticky top-0 z-20 border-b border-[#1e222a] bg-[#0b0d11]/95 backdrop-blur",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex items-center gap-2.5",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_14px_rgba(16,185,129,0.35)]",
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$zap$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Zap$3e$__["Zap"], {
                                className: "h-4.5 w-4.5 text-black",
                                strokeWidth: 2.5
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/header.tsx",
                                lineNumber: 47,
                                columnNumber: 13
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 46,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "leading-tight",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-2",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-sm font-bold tracking-wider text-zinc-100",
                                            children: "XARB"
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/header.tsx",
                                            lineNumber: 51,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-amber-400",
                                            children: "PAPER"
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/header.tsx",
                                            lineNumber: 52,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 50,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "hidden text-[10px] text-zinc-500 sm:block",
                                    children: "Binance → Polymarket up/down series · multi-market latency arb · both sides"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 56,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 49,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/header.tsx",
                    lineNumber: 45,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex flex-wrap items-center gap-1.5",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "BINANCE",
                            status: binStatus,
                            extra: binLat ? `${binLat}ms` : undefined
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 64,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "POLYMARKET",
                            status: pmStatus
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 65,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "MARKETS",
                            status: marketsLive > 0 ? 'live' : 'down',
                            extra: `${marketsLive}/${marketsTotal}`
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 66,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "ENGINE",
                            status: running ? 'live' : 'down',
                            extra: running ? 'running' : 'stopped'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 71,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "WS",
                            status: connected ? 'live' : 'down'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 76,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "σ-CAL",
                            status: sigmaAuto ? 'live' : 'down',
                            extra: sigmaAuto ? 'auto' : 'legacy'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 77,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "δ-HEDGE",
                            status: hedgeOn ? hedgeActive ? 'live' : 'connecting' : 'down',
                            extra: hedgeOn ? hedgeActive ? 'holding' : 'armed' : 'off'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 82,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(FeedBadge, {
                            label: "SIDE-DOWN",
                            status: sideDown ? 'live' : 'down',
                            extra: sideDown ? 'capture' : 'up only'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 87,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/header.tsx",
                    lineNumber: 63,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "ms-auto flex items-center gap-2",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "hidden items-center gap-2 rounded-md border border-[#262b33] bg-[#12151b] px-2.5 py-1 md:flex",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$radio$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Radio$3e$__["Radio"], {
                                    className: "h-3 w-3 text-amber-400"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 97,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "text-[10px] font-bold text-cyan-300",
                                    children: focus?.label ?? '—'
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 98,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "font-mono text-xs tabular-nums text-amber-300",
                                    children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCountdown"])(secsLeft)
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 99,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "text-[10px] text-zinc-500",
                                    children: [
                                        "to close · K ",
                                        strike != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(strike, focus?.priceDp ?? 1) : '—'
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 100,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 96,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                            onClick: ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sendControl"])({
                                    type: running ? 'stop' : 'start'
                                }),
                            className: `inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${running ? 'border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}`,
                            children: [
                                running ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$square$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Square$3e$__["Square"], {
                                    className: "h-3.5 w-3.5"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 113,
                                    columnNumber: 24
                                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$play$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Play$3e$__["Play"], {
                                    className: "h-3.5 w-3.5"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/header.tsx",
                                    lineNumber: 113,
                                    columnNumber: 61
                                }, this),
                                running ? 'STOP' : 'START'
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 105,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$settings$2d$sheet$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SettingsSheet"], {
                            trigger: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                className: "inline-flex h-8 items-center gap-1.5 rounded-md border border-[#262b33] bg-[#12151b] px-3 text-xs font-semibold text-zinc-300 hover:bg-[#1a1e25]",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2d$2$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings2$3e$__["Settings2"], {
                                        className: "h-3.5 w-3.5"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/header.tsx",
                                        lineNumber: 120,
                                        columnNumber: 17
                                    }, void 0),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "hidden sm:inline",
                                        children: "Settings"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/header.tsx",
                                        lineNumber: 121,
                                        columnNumber: 17
                                    }, void 0)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/header.tsx",
                                lineNumber: 119,
                                columnNumber: 15
                            }, void 0)
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/header.tsx",
                            lineNumber: 117,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/header.tsx",
                    lineNumber: 94,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/components/xarb/header.tsx",
            lineNumber: 43,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/header.tsx",
        lineNumber: 42,
        columnNumber: 5
    }, this);
}
_s(Header, "Sm1CSQum+xYumUg0A84WA+LWTw8=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c1 = Header;
var _c, _c1;
__turbopack_context__.k.register(_c, "FeedBadge");
__turbopack_context__.k.register(_c1, "Header");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/stat-cards.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "StatCards",
    ()=>StatCards,
    "V04Cards",
    ()=>V04Cards
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$sigma$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Sigma$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/sigma.js [app-client] (ecmascript) <export default as Sigma>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2d$half$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ShieldHalf$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/shield-half.js [app-client] (ecmascript) <export default as ShieldHalf>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$crosshair$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Crosshair$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/crosshair.js [app-client] (ecmascript) <export default as Crosshair>");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
function Card({ title, hint, children, accent }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "relative overflow-hidden rounded-lg border border-[#22262e] bg-[#101318] p-3.5",
        children: [
            accent ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: `absolute inset-x-0 top-0 h-[2px] ${accent}`
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 19,
                columnNumber: 17
            }, this) : null,
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "mb-1.5 flex items-baseline justify-between gap-2",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "truncate text-[10px] font-semibold uppercase tracking-widest text-zinc-500",
                        children: title
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 21,
                        columnNumber: 9
                    }, this),
                    hint ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "shrink-0 text-[9px] text-zinc-600",
                        children: hint
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 22,
                        columnNumber: 17
                    }, this) : null
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 20,
                columnNumber: 7
            }, this),
            children
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/stat-cards.tsx",
        lineNumber: 18,
        columnNumber: 5
    }, this);
}
_c = Card;
const big = 'font-mono text-[26px] leading-none font-semibold tabular-nums tracking-tight';
const sub = 'mt-1.5 flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-zinc-500';
function Delta({ v, suffix = '', digits = 1 }) {
    if (!Number.isFinite(v)) return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: "text-zinc-600",
        children: "—"
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/stat-cards.tsx",
        lineNumber: 33,
        columnNumber: 35
    }, this);
    const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500';
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: cls,
        children: [
            v > 0 ? '+' : '',
            v.toFixed(digits),
            suffix
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/stat-cards.tsx",
        lineNumber: 36,
        columnNumber: 5
    }, this);
}
_c1 = Delta;
function StatCards() {
    _s();
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[focus]": (s)=>s.snapshot?.focus
    }["StatCards.useXarb[focus]"]);
    const bin = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[bin]": (s)=>s.snapshot?.binance
    }["StatCards.useXarb[bin]"]);
    const window = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[window]": (s)=>s.snapshot?.window
    }["StatCards.useXarb[window]"]);
    const fv = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[fv]": (s)=>s.snapshot?.fv
    }["StatCards.useXarb[fv]"]);
    const pm = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[pm]": (s)=>s.snapshot?.pm
    }["StatCards.useXarb[pm]"]);
    const edge = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[edge]": (s)=>s.snapshot?.edge
    }["StatCards.useXarb[edge]"]);
    const stats = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[stats]": (s)=>s.snapshot?.stats
    }["StatCards.useXarb[stats]"]);
    const edgeThresh = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[edgeThresh]": (s)=>s.settings.edgeThreshC
    }["StatCards.useXarb[edgeThresh]"]);
    const sideDown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[sideDown]": (s)=>s.snapshot?.sideDown ?? true
    }["StatCards.useXarb[sideDown]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["StatCards.useXarb[marketsLive]"]);
    const marketsTotal = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[marketsTotal]": (s)=>s.snapshot?.marketsTotal ?? 0
    }["StatCards.useXarb[marketsTotal]"]);
    const feedBps = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "StatCards.useXarb[feedBps]": (s)=>s.snapshot?.feeds.polymarket.feeRateBps ?? null
    }["StatCards.useXarb[feedBps]"]);
    const dp = focus?.priceDp ?? 1;
    const label = focus?.label ?? 'BTC 5m';
    const price = bin?.price ?? null;
    const change5s = bin?.change5s ?? 0;
    const secsLeft = window?.secondsLeft ?? 0;
    const winSec = focus?.windowSec ?? 300;
    const model = fv?.model ?? 'cdf';
    const fvVal = fv?.value ?? 50;
    const fvDn = fv?.valueDown ?? 50;
    const jump5s = fv?.jump5s ?? 0;
    const jump5sDn = fv?.jump5sDown ?? 0;
    const zScore = fv?.z ?? 0;
    const sigmaEffPts = fv?.sigmaEffPts ?? 15.5;
    const sigmaEffBps = fv?.sigmaEffBps ?? 0;
    const dist = fv?.distFromStrike ?? 0;
    const slope = fv?.slope ?? 0;
    const edgeUp = edge?.fvAsk ?? null;
    const edgeDn = edge?.dnFvAsk ?? null;
    const edgeCls = edgeUp == null ? 'text-zinc-500' : edgeUp >= edgeThresh ? 'text-emerald-400' : edgeUp > 0 ? 'text-emerald-300/70' : 'text-red-400';
    const pnlCls = (stats?.pnlTotal ?? 0) > 0 ? 'text-emerald-400' : (stats?.pnlTotal ?? 0) < 0 ? 'text-red-400' : 'text-zinc-400';
    const progress = Math.min(Math.max(secsLeft / winSec, 0), 1);
    const bestEdge = Math.max(edgeUp ?? -Infinity, edgeDn ?? -Infinity);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: `${focus?.asset ?? 'BTC'} spot`,
                hint: `${focus?.binanceSym ?? 'BTCUSDT'} · Binance live`,
                accent: "bg-orange-500/70",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `${big} text-orange-300`,
                        children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(price, dp)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 93,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(bin?.bid ?? 0, dp),
                                    " / ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(bin?.ask ?? 0, dp)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 95,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Delta, {
                                v: change5s,
                                suffix: " pts",
                                digits: dp
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 98,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 94,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                "focus market: ",
                                label
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 101,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 100,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 92,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "window",
                hint: `${label} · UP resolves ≥ strike`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `${big} text-zinc-100`,
                        children: [
                            window?.strike != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(window.strike, dp) : '—',
                            window?.strikeEstimated ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "ms-1.5 align-middle text-[9px] font-bold text-amber-400/80",
                                children: "EST"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 109,
                                columnNumber: 13
                            }, this) : null
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 106,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-amber-300",
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCountdown"])(secsLeft)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 113,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "h-1 flex-1 overflow-hidden rounded bg-[#1a1e25]",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "h-full rounded bg-gradient-to-r from-amber-500 to-amber-300 transition-[width] duration-300",
                                    style: {
                                        width: `${progress * 100}%`
                                    }
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                    lineNumber: 115,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 114,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 112,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "mt-1 truncate text-[9px] text-zinc-600",
                        title: window?.question ?? '',
                        children: window?.question || 'discovering window…'
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 121,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 105,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "fair value up / dn",
                hint: model === 'linear' ? 'linear spec model' : 'normal-cdf · σ auto-cal',
                accent: "bg-emerald-500/70",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-baseline gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} ${fvVal >= 60 ? 'text-emerald-300' : 'text-emerald-300/80'}`,
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(fvVal)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 132,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} text-zinc-500`,
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(fvDn)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 133,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 131,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: "5sΔ"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 136,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Delta, {
                                v: jump5s,
                                suffix: "¢"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 137,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "dn"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 138,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Delta, {
                                v: jump5sDn,
                                suffix: "¢"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 139,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 135,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                "z ",
                                zScore >= 0 ? '+' : '',
                                zScore.toFixed(2),
                                "σ · σ_eff ",
                                sigmaEffBps.toFixed(1),
                                "bp/√s · slope ",
                                slope.toFixed(3),
                                "¢/pt"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 142,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 141,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: model === 'linear' ? 'legacy spec curve' : 'Φ(z) both sides · bounded 1–99¢'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 148,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 147,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 126,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "Polymarket up / dn",
                hint: "CLOB top of book",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-baseline gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} text-amber-300`,
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(pm?.ask)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 156,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} text-amber-300/50`,
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(pm?.dnAsk)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 157,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 155,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "bid ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(pm?.bid)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 160,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "dn bid ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(pm?.dnBid)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 161,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "sz ",
                                    Math.round(pm?.askSize ?? 0)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 162,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: (pm?.bookAgeMs ?? 9e9) > 3000 ? 'text-red-400' : 'text-zinc-500',
                                children: [
                                    "age ",
                                    pm && pm.bookAgeMs > 99999 ? '—' : `${Math.round(pm?.bookAgeMs ?? 0)}ms`
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 163,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 159,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                "live taker fee ",
                                feedBps != null ? `${feedBps} bps` : '—',
                                " · both tokens subscribed"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 168,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 167,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 154,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "Edge · FV − ask",
                hint: `fires ≥ ${edgeThresh}¢ · best side`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `${big} ${bestEdge === edgeDn && sideDown ? 'text-cyan-300' : edgeCls}`,
                        children: bestEdge === -Infinity ? '—' : `${bestEdge >= 0 ? '+' : ''}${bestEdge.toFixed(1)}¢`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 173,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "up ",
                                    edgeUp == null ? '—' : (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(edgeUp)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 177,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "dn"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 178,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: sideDown ? 'text-zinc-400' : 'text-zinc-600 line-through',
                                children: edgeDn == null ? '—' : (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(edgeDn)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 179,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 176,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "h-1.5 flex-1 overflow-hidden rounded bg-[#1a1e25]",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: `h-full rounded ${bestEdge >= edgeThresh ? 'bg-emerald-400' : 'bg-emerald-400/30'}`,
                                    style: {
                                        width: `${Math.min(Math.max(bestEdge / edgeThresh, 0), 1) * 100}%`
                                    }
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                    lineNumber: 185,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 184,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: [
                                    Math.max(0, edgeThresh - bestEdge).toFixed(1),
                                    "¢ to go"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 190,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 183,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 172,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "Session P&L",
                hint: `paper · all ${marketsLive}/${marketsTotal} markets`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `${big} ${pnlCls}`,
                        children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPnl"])(stats?.pnlTotal ?? 0)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 195,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "real ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPnl"])(stats?.pnlRealized ?? 0)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 197,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: [
                                    "open ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPnl"])(stats?.pnlUnrealized ?? 0)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 198,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 196,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                stats?.trades ?? 0,
                                " trades · ",
                                (stats?.winRate ?? 0).toFixed(0),
                                "% win · avg ",
                                (stats?.avgEdgeC ?? 0).toFixed(1),
                                "¢ edge"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 201,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 200,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 194,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/stat-cards.tsx",
        lineNumber: 91,
        columnNumber: 5
    }, this);
}
_s(StatCards, "4h9pZiMY0CgB/DwvjwvTakEpr90=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c2 = StatCards;
function V04Cards() {
    _s1();
    const sigma = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[sigma]": (s)=>s.snapshot?.sigma
    }["V04Cards.useXarb[sigma]"]);
    const hedge = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[hedge]": (s)=>s.snapshot?.hedge
    }["V04Cards.useXarb[hedge]"]);
    const capture = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[capture]": (s)=>s.snapshot?.capture
    }["V04Cards.useXarb[capture]"]);
    const netEdge = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[netEdge]": (s)=>s.snapshot?.edge.net ?? null
    }["V04Cards.useXarb[netEdge]"]);
    const minNetEdge = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[minNetEdge]": (s)=>s.settings.minNetEdgeC
    }["V04Cards.useXarb[minNetEdge]"]);
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[focus]": (s)=>s.snapshot?.focus
    }["V04Cards.useXarb[focus]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["V04Cards.useXarb[marketsLive]"]);
    const spot = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "V04Cards.useXarb[spot]": (s)=>s.snapshot?.binance.price ?? 0
    }["V04Cards.useXarb[spot]"]);
    const asset = hedge?.asset ?? focus?.asset ?? 'BTC';
    const snapFresh = !!sigma?.effIsSnap;
    const snapAge = sigma?.snapAgeMs;
    const capRatio = capture && capture.edgeSeenC > 1 && capture.fired > 0 ? Math.min(capture.avgNetEdgeC * capture.fired / capture.edgeSeenC, 1.5) : null;
    const sigmaBps = sigma && spot > 0 ? sigma.eff / spot * 1e4 : null;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "grid grid-cols-1 gap-3 md:grid-cols-3",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "σ auto-calibration",
                hint: sigma?.auto ? `from live PM mids · ${focus?.label ?? ''}` : 'legacy fixed floor',
                accent: "bg-cyan-500/70",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-baseline gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$sigma$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Sigma$3e$__["Sigma"], {
                                className: "h-4 w-4 text-cyan-400/70"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 240,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} text-cyan-300`,
                                children: [
                                    sigma ? sigma.eff.toFixed(2) : '—',
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "ms-1 text-[10px] font-normal text-zinc-500",
                                        children: "pts/√s"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                        lineNumber: 243,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 241,
                                columnNumber: 11
                            }, this),
                            sigmaBps != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "font-mono text-[10px] tabular-nums text-zinc-500",
                                children: [
                                    sigmaBps.toFixed(1),
                                    " bp/√s"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 246,
                                columnNumber: 13
                            }, this) : null
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 239,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "imp"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 250,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-cyan-200/90",
                                children: sigma ? sigma.imp.toFixed(2) : '—'
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 251,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "real"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 252,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: sigma ? sigma.real.toFixed(2) : '—'
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 253,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "floor"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 254,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: sigma ? sigma.floor.toFixed(2) : '—'
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 255,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 249,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: sigma?.auto ? snapFresh ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "font-semibold text-cyan-300",
                            children: [
                                "SNAP locked · FV tracks PM (",
                                snapAge != null ? `${Math.round(snapAge)}ms` : '—',
                                ")"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 260,
                            columnNumber: 15
                        }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-500",
                            children: "blend + dynamic floor · PM silent → FV floats with Binance"
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 264,
                            columnNumber: 15
                        }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-500",
                            children: "auto-cal off · legacy clamp of realized σ"
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 267,
                            columnNumber: 13
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 257,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                "samples ",
                                sigma ? sigma.accepted : 0,
                                "✓ / ",
                                sigma ? sigma.rejected : 0,
                                "✗ · |Φ⁻¹(mid)| gate rejects unidentifiable mids"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 271,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 270,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 234,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "δ-hedge · Binance",
                hint: hedge?.on ? `ratio ${(hedge.ratio * 100).toFixed(0)}% · ${(hedge.feeBps ?? 0).toFixed(1)}bps` : 'off',
                accent: "bg-fuchsia-500/70",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-baseline gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2d$half$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ShieldHalf$3e$__["ShieldHalf"], {
                                className: "h-4 w-4 text-fuchsia-400/70"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 284,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} ${hedge?.active ? 'text-fuchsia-300' : 'text-zinc-500'}`,
                                children: [
                                    hedge?.active ? `${hedge.qtyBtc}` : 'FLAT',
                                    hedge?.active ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "ms-1 text-[10px] font-normal text-zinc-500",
                                        children: asset
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                        lineNumber: 287,
                                        columnNumber: 30
                                    }, this) : null
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 285,
                                columnNumber: 11
                            }, this),
                            hedge?.winddown && hedge?.active ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-bold text-amber-400",
                                children: "WIND-DOWN"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 290,
                                columnNumber: 13
                            }, this) : null
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 283,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "target"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 296,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-fuchsia-200/90",
                                children: hedge ? hedge.targetBtc : '—'
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 297,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: [
                                    "band ±",
                                    hedge ? hedge.bandBtc : '—'
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 298,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 295,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: [
                                    "Δ/sh ",
                                    hedge ? hedge.deltaPerShare.toFixed(5) : '—',
                                    " ",
                                    asset
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 301,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: hedge?.active ? 'text-zinc-400' : 'text-zinc-600',
                                children: hedge?.shares ? `${Math.round(hedge.shares)} sh` : ''
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 302,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 300,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Delta, {
                                v: hedge?.pnlUsd ?? 0,
                                suffix: " pnl",
                                digits: 2
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 307,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: [
                                    "fees $",
                                    hedge ? hedge.feesUsd.toFixed(3) : '0',
                                    " · ",
                                    hedge?.fills ?? 0,
                                    " fills · W–W band"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 308,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 306,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 278,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Card, {
                title: "Value capture",
                hint: "zero engine-miss · whole universe",
                accent: "bg-emerald-500/70",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-baseline gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$crosshair$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Crosshair$3e$__["Crosshair"], {
                                className: "h-4 w-4 text-emerald-400/70"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 315,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `${big} ${netEdge != null && netEdge >= minNetEdge ? 'text-emerald-300' : 'text-zinc-200'}`,
                                children: [
                                    netEdge != null ? `${netEdge >= 0 ? '+' : ''}${netEdge.toFixed(1)}` : '—',
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "ms-1 text-[10px] font-normal text-zinc-500",
                                        children: "¢ net edge"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                        lineNumber: 318,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 316,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 314,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                "edge − PM fee − hedge cost · fires ≥ ",
                                minNetEdge,
                                "¢ — the profit gate (",
                                focus?.label ?? '',
                                ")"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 322,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 321,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "opps"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 327,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-emerald-200/90",
                                children: capture?.opportunities ?? 0
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 328,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "fired"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 329,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                children: capture?.fired ?? 0
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 330,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "gated"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 331,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-amber-300/90",
                                children: capture?.missed ?? 0
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 332,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-zinc-600",
                                children: "early exits"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 333,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "text-cyan-300/90",
                                children: capture?.earlyExits ?? 0
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                                lineNumber: 334,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 326,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: sub,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-600",
                            children: [
                                marketsLive,
                                " markets · edge seen ",
                                (capture?.edgeSeenC ?? 0).toFixed(0),
                                "¢ · avg net",
                                ' ',
                                capture && capture.fired > 0 ? `${capture.avgNetEdgeC >= 0 ? '+' : ''}${capture.avgNetEdgeC.toFixed(1)}¢` : '—',
                                capRatio != null ? ` · capture ${(capRatio * 100).toFixed(0)}%` : ''
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/stat-cards.tsx",
                            lineNumber: 337,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/stat-cards.tsx",
                        lineNumber: 336,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/stat-cards.tsx",
                lineNumber: 313,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/stat-cards.tsx",
        lineNumber: 232,
        columnNumber: 5
    }, this);
}
_s1(V04Cards, "rQ6x6XpmXwIej/wKZ28UJBzZIEI=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c3 = V04Cards;
var _c, _c1, _c2, _c3;
__turbopack_context__.k.register(_c, "Card");
__turbopack_context__.k.register(_c1, "Delta");
__turbopack_context__.k.register(_c2, "StatCards");
__turbopack_context__.k.register(_c3, "V04Cards");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/charts.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "FvChart",
    ()=>FvChart,
    "PriceChart",
    ()=>PriceChart
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
// ─── XARB live canvas charts: BTC price + FV/ask ─────────────────────────────
// rAF-rendered from module-level ring buffers (no React re-renders in the loop)
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
const MONO = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const VIEW_MS = 180_000 // 3-minute visible window
;
const C = {
    grid: '#1b2027',
    label: '#5b6572',
    price: '#fb923c',
    fv: '#34d399',
    ask: '#fbbf24',
    strike: '#8b949e',
    floor: '#f87171',
    marker: '#10b981',
    posFill: 'rgba(16,185,129,0.16)',
    negFill: 'rgba(239,68,68,0.07)',
    cross: '#3d434d',
    info: '#9aa4b2',
    winEnd: 'rgba(245,158,11,0.55)'
};
const PAD = {
    l: 8,
    r: 58,
    t: 12,
    b: 18
};
function setup(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return null;
    const pw = Math.floor(W * dpr);
    const ph = Math.floor(H * dpr);
    if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return {
        ctx,
        W,
        H
    };
}
function drawTimeGrid(g, t0, t1) {
    const { ctx, W, H } = g;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const x = (t)=>PAD.l + (t - t0) / (t1 - t0) * plotW;
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.label;
    ctx.font = MONO;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    const step = 30_000;
    for(let t = Math.ceil(t0 / step) * step; t <= t1; t += step){
        const px = Math.round(x(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, PAD.t);
        ctx.lineTo(px, PAD.t + plotH);
        ctx.stroke();
        ctx.fillText((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtClock"])(t), px, H - 5);
    }
    return plotW;
}
function priceAt(ts) {
    // nearest/interpolated price from the ring buffer
    const buf = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["chartBuf"];
    if (!buf.length) return null;
    if (ts <= buf[0].t) return buf[0].price;
    if (ts >= buf[buf.length - 1].t) return buf[buf.length - 1].price;
    for(let i = 1; i < buf.length; i++){
        if (buf[i].t >= ts) {
            const a = buf[i - 1];
            const b = buf[i];
            const f = (ts - a.t) / (b.t - a.t || 1);
            return a.price + f * (b.price - a.price);
        }
    }
    return null;
}
function tag(g, y, text, bg) {
    const { ctx, W } = g;
    const w = ctx.measureText(text).width + 10;
    const x = W - PAD.r + 2;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x, y - 8, w, 15, 3);
    ctx.fill();
    ctx.fillStyle = '#0a0c10';
    ctx.textAlign = 'left';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillText(text, x + 5, y + 3);
    ctx.font = MONO;
}
function crosshair(g, t0, t1, mouse, lines) {
    if (!mouse.on) return;
    const { ctx, W, H } = g;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    if (mouse.x < PAD.l || mouse.x > PAD.l + plotW) return;
    const t = t0 + (mouse.x - PAD.l) / plotW * (t1 - t0);
    const p = priceAt(t);
    ctx.strokeStyle = C.cross;
    ctx.setLineDash([
        3,
        3
    ]);
    ctx.beginPath();
    ctx.moveTo(Math.round(mouse.x) + 0.5, PAD.t);
    ctx.lineTo(Math.round(mouse.x) + 0.5, PAD.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    if (p == null) return;
    // nearest chart point values
    let best = null;
    for (const pt of __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["chartBuf"]){
        if (pt.t > t) break;
        best = pt;
    }
    if (!best) return;
    ctx.fillStyle = C.info;
    ctx.font = MONO;
    ctx.textAlign = 'left';
    const rows = lines({
        t,
        price: p,
        fv: best.fv,
        pmAsk: best.pmAsk,
        edge: best.edge
    });
    rows.forEach((r, i)=>ctx.fillText(r, PAD.l + 6, PAD.t + 12 + i * 13));
}
function markers(g, t0, t1, yOf) {
    const { ctx, W, H } = g;
    const plotW = W - PAD.l - PAD.r;
    const trades = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"].getState().trades;
    const x = (t)=>PAD.l + (t - t0) / (t1 - t0) * plotW;
    for (const tr of trades){
        if (tr.ts < t0 || tr.ts > t1) continue;
        const y = yOf(tr);
        if (y == null) continue;
        const px = x(tr.ts);
        ctx.fillStyle = tr.status === 'LOST' ? '#ef4444' : C.marker;
        ctx.beginPath();
        ctx.moveTo(px, y - 6);
        ctx.lineTo(px - 4.5, y + 4);
        ctx.lineTo(px + 4.5, y + 4);
        ctx.closePath();
        ctx.fill();
        // tick to bottom
        ctx.strokeStyle = 'rgba(16,185,129,0.25)';
        ctx.beginPath();
        ctx.moveTo(px + 0.5, y + 6);
        ctx.lineTo(px + 0.5, H - PAD.b);
        ctx.stroke();
    }
}
function PriceChart() {
    _s();
    const ref = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const mouse = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])({
        x: 0,
        on: false
    });
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "PriceChart.useEffect": ()=>{
            const c = ref.current;
            if (!c) return;
            const move = {
                "PriceChart.useEffect.move": (e)=>{
                    const r = c.getBoundingClientRect();
                    mouse.current = {
                        x: e.clientX - r.left,
                        on: true
                    };
                }
            }["PriceChart.useEffect.move"];
            const leave = {
                "PriceChart.useEffect.leave": ()=>mouse.current.on = false
            }["PriceChart.useEffect.leave"];
            c.addEventListener('mousemove', move);
            c.addEventListener('mouseleave', leave);
            let raf = 0;
            const loop = {
                "PriceChart.useEffect.loop": ()=>{
                    draw(c, mouse.current);
                    raf = requestAnimationFrame(loop);
                }
            }["PriceChart.useEffect.loop"];
            raf = requestAnimationFrame(loop);
            return ({
                "PriceChart.useEffect": ()=>{
                    cancelAnimationFrame(raf);
                    c.removeEventListener('mousemove', move);
                    c.removeEventListener('mouseleave', leave);
                }
            })["PriceChart.useEffect"];
        }
    }["PriceChart.useEffect"], []);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("canvas", {
        ref: ref,
        className: "block h-[230px] w-full cursor-crosshair sm:h-[250px]",
        "aria-label": "Focus market price chart",
        role: "img"
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/charts.tsx",
        lineNumber: 200,
        columnNumber: 10
    }, this);
}
_s(PriceChart, "7XhXTmraE+ef/hplwfumGdtTF1E=");
_c = PriceChart;
function draw(c, mouse) {
    const g = setup(c);
    if (!g) return;
    const { ctx, W, H } = g;
    const t1 = Date.now();
    const t0 = t1 - VIEW_MS;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const snap = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"].getState().snapshot;
    const strike = snap?.window.strike ?? null;
    const winEnd = snap?.window.endEpoch ?? 0;
    const dp = snap?.focus?.priceDp ?? 1;
    const asset = snap?.focus?.asset ?? 'BTC';
    const pts = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["chartBuf"].filter((p)=>p.t >= t0);
    if (pts.length < 2) {
        ctx.fillStyle = C.label;
        ctx.font = MONO;
        ctx.textAlign = 'center';
        ctx.fillText('waiting for live data…', W / 2, H / 2);
        return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts){
        if (p.price < lo) lo = p.price;
        if (p.price > hi) hi = p.price;
    }
    if (strike != null) {
        lo = Math.min(lo, strike);
        hi = Math.max(hi, strike);
    }
    const pad = Math.max((hi - lo) * 0.12, 2);
    lo -= pad;
    hi += pad;
    const y = (v)=>PAD.t + (1 - (v - lo) / (hi - lo)) * plotH;
    const x = (t)=>PAD.l + (t - t0) / (t1 - t0) * plotW;
    drawTimeGrid(g, t0, t1);
    // y labels (price)
    ctx.font = MONO;
    ctx.textAlign = 'left';
    for(let i = 0; i <= 4; i++){
        const v = lo + (hi - lo) * i / 4;
        const py = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(PAD.l, py);
        ctx.lineTo(PAD.l + plotW, py);
        ctx.stroke();
        ctx.fillStyle = C.label;
        ctx.fillText((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(v, dp > 2 ? 3 : 0), W - PAD.r + 4, py + 3);
    }
    // window end marker
    if (winEnd * 1000 > t0 && winEnd * 1000 < t1) {
        const px = Math.round(x(winEnd * 1000)) + 0.5;
        ctx.strokeStyle = C.winEnd;
        ctx.setLineDash([
            4,
            4
        ]);
        ctx.beginPath();
        ctx.moveTo(px, PAD.t);
        ctx.lineTo(px, PAD.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.winEnd;
        ctx.textAlign = 'right';
        ctx.fillText('window end', px - 4, PAD.t + 10);
        ctx.textAlign = 'left';
    }
    // strike line
    if (strike != null && strike > lo && strike < hi) {
        const py = Math.round(y(strike)) + 0.5;
        ctx.strokeStyle = C.strike;
        ctx.setLineDash([
            5,
            4
        ]);
        ctx.beginPath();
        ctx.moveTo(PAD.l, py);
        ctx.lineTo(PAD.l + plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.strike;
        ctx.textAlign = 'left';
        ctx.fillText(`K ${(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(strike, dp)}`, PAD.l + 4, py - 4);
    }
    // price line
    ctx.strokeStyle = C.price;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach((p, i)=>{
        const px = x(p.t);
        const py = y(p.price);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.lineWidth = 1;
    // current dot
    const lastP = pts[pts.length - 1];
    ctx.fillStyle = C.price;
    ctx.beginPath();
    ctx.arc(x(lastP.t), y(lastP.price), 3, 0, Math.PI * 2);
    ctx.fill();
    tag(g, y(lastP.price), (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(lastP.price, dp), C.price);
    // trade markers
    markers(g, t0, t1, (tr)=>{
        const p = priceAt(tr.ts);
        return p == null ? null : y(p);
    });
    crosshair(g, t0, t1, mouse, (v)=>[
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtClock"])(v.t),
            `${asset} ${(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(v.price, dp)}`
        ]);
}
function FvChart() {
    _s1();
    const ref = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const mouse = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])({
        x: 0,
        on: false
    });
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "FvChart.useEffect": ()=>{
            const c = ref.current;
            if (!c) return;
            const move = {
                "FvChart.useEffect.move": (e)=>{
                    const r = c.getBoundingClientRect();
                    mouse.current = {
                        x: e.clientX - r.left,
                        on: true
                    };
                }
            }["FvChart.useEffect.move"];
            const leave = {
                "FvChart.useEffect.leave": ()=>mouse.current.on = false
            }["FvChart.useEffect.leave"];
            c.addEventListener('mousemove', move);
            c.addEventListener('mouseleave', leave);
            let raf = 0;
            const loop = {
                "FvChart.useEffect.loop": ()=>{
                    drawFv(c, mouse.current);
                    raf = requestAnimationFrame(loop);
                }
            }["FvChart.useEffect.loop"];
            raf = requestAnimationFrame(loop);
            return ({
                "FvChart.useEffect": ()=>{
                    cancelAnimationFrame(raf);
                    c.removeEventListener('mousemove', move);
                    c.removeEventListener('mouseleave', leave);
                }
            })["FvChart.useEffect"];
        }
    }["FvChart.useEffect"], []);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("canvas", {
        ref: ref,
        className: "block h-[180px] w-full cursor-crosshair sm:h-[200px]",
        "aria-label": "Fair value versus Polymarket ask chart",
        role: "img"
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/charts.tsx",
        lineNumber: 350,
        columnNumber: 10
    }, this);
}
_s1(FvChart, "7XhXTmraE+ef/hplwfumGdtTF1E=");
_c1 = FvChart;
function drawFv(c, mouse) {
    const g = setup(c);
    if (!g) return;
    const { ctx, W, H } = g;
    const t1 = Date.now();
    const t0 = t1 - VIEW_MS;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const snap = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"].getState().snapshot;
    const floor = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"].getState().settings.fvFloorC;
    const pts = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["chartBuf"].filter((p)=>p.t >= t0);
    if (pts.length < 2) {
        ctx.fillStyle = C.label;
        ctx.font = MONO;
        ctx.textAlign = 'center';
        ctx.fillText('waiting for live data…', W / 2, H / 2);
        return;
    }
    const y = (v)=>PAD.t + (1 - v / 100) * plotH;
    const x = (t)=>PAD.l + (t - t0) / (t1 - t0) * plotW;
    drawTimeGrid(g, t0, t1);
    // y grid fixed 0..100
    ctx.font = MONO;
    for(let v = 0; v <= 100; v += 25){
        const py = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(PAD.l, py);
        ctx.lineTo(PAD.l + plotW, py);
        ctx.stroke();
        ctx.fillStyle = C.label;
        ctx.textAlign = 'left';
        ctx.fillText(`${v}¢`, W - PAD.r + 4, py + 3);
    }
    // edge shading: per-column fill between FV and ask lines
    const stepPx = 2;
    for(let px = PAD.l; px < PAD.l + plotW; px += stepPx){
        const tA = t0 + (px - PAD.l) / plotW * (t1 - t0);
        const tB = t0 + (px + stepPx - PAD.l) / plotW * (t1 - t0);
        let fa = null;
        let fb = null;
        for (const p of pts){
            if (p.t <= tA) fa = p;
            if (p.t <= tB) fb = p;
            if (p.t > tB && fa && fb) break;
        }
        if (!fa || !fb || !fa.pmAsk || !fb.pmAsk) continue;
        ctx.fillStyle = fa.fv > fa.pmAsk || fb.fv > fb.pmAsk ? C.posFill : C.negFill;
        ctx.beginPath();
        ctx.moveTo(px, y(fa.fv));
        ctx.lineTo(px + stepPx, y(fb.fv));
        ctx.lineTo(px + stepPx, y(fb.pmAsk));
        ctx.lineTo(px, y(fa.pmAsk));
        ctx.closePath();
        ctx.fill();
    }
    // FV floor line
    const py = Math.round(y(floor)) + 0.5;
    ctx.strokeStyle = C.floor;
    ctx.setLineDash([
        4,
        4
    ]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, py);
    ctx.lineTo(PAD.l + plotW, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.floor;
    ctx.textAlign = 'left';
    ctx.fillText(`floor ${floor}¢`, PAD.l + 4, py - 4);
    // PM ask line
    ctx.strokeStyle = C.ask;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let drawingAsk = false;
    pts.forEach((p)=>{
        if (!p.pmAsk) {
            drawingAsk = false;
            return;
        }
        const px = x(p.t);
        const pyA = y(p.pmAsk);
        if (!drawingAsk) {
            ctx.moveTo(px, pyA);
            drawingAsk = true;
        } else ctx.lineTo(px, pyA);
    });
    ctx.stroke();
    // FV line
    ctx.strokeStyle = C.fv;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach((p, i)=>{
        const px = x(p.t);
        const pyF = y(p.fv);
        if (i === 0) ctx.moveTo(px, pyF);
        else ctx.lineTo(px, pyF);
    });
    ctx.stroke();
    ctx.lineWidth = 1;
    // current tags
    const last = pts[pts.length - 1];
    if (last.pmAsk) tag(g, y(last.pmAsk), `${last.pmAsk.toFixed(1)}¢ ask`, C.ask);
    tag(g, Math.min(Math.max(y(last.fv), PAD.t + 8), PAD.t + plotH - 8), `${last.fv.toFixed(1)}¢ fv`, C.fv);
    // trade markers at fill price
    markers(g, t0, t1, (tr)=>tr.priceC > 0 && tr.priceC < 100 ? y(tr.priceC) : null);
    crosshair(g, t0, t1, mouse, (v)=>[
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtClock"])(v.t),
            `FV ${v.fv.toFixed(1)}¢ · PM ${v.pmAsk ? v.pmAsk.toFixed(1) + '¢' : '—'}`,
            `edge ${v.edge >= 0 ? '+' : ''}${v.edge.toFixed(1)}¢`
        ]);
}
var _c, _c1;
__turbopack_context__.k.register(_c, "PriceChart");
__turbopack_context__.k.register(_c1, "FvChart");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/panels.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "BookLadder",
    ()=>BookLadder,
    "LatencyPanel",
    ()=>LatencyPanel,
    "TriggerPanel",
    ()=>TriggerPanel
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$activity$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Activity$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/activity.js [app-client] (ecmascript) <export default as Activity>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$book$2d$open$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__BookOpen$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/book-open.js [app-client] (ecmascript) <export default as BookOpen>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$gauge$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Gauge$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/gauge.js [app-client] (ecmascript) <export default as Gauge>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowUp$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/arrow-up.js [app-client] (ecmascript) <export default as ArrowUp>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$down$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowDown$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/arrow-down.js [app-client] (ecmascript) <export default as ArrowDown>");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature(), _s2 = __turbopack_context__.k.signature();
'use client';
;
;
function PanelShell({ icon, title, hint, children, className }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: `flex flex-col rounded-lg border border-[#22262e] bg-[#101318] ${className ?? ''}`,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5",
                children: [
                    icon,
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-[11px] font-semibold uppercase tracking-widest text-zinc-400",
                        children: title
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 23,
                        columnNumber: 9
                    }, this),
                    hint ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "ms-auto text-[9px] text-zinc-600",
                        children: hint
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 24,
                        columnNumber: 17
                    }, this) : null
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 21,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex-1 p-3.5",
                children: children
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 26,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 20,
        columnNumber: 5
    }, this);
}
_c = PanelShell;
// ─── trigger conditions (both sides of the focus market) ────────────────────
function TriggerRow({ label, value, threshold, unit, armed, progress, dim }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: `py-1.5 ${dim ? 'opacity-50' : ''}`,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-2.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: `h-2.5 w-2.5 shrink-0 rounded-full border ${armed ? 'border-emerald-400 bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse' : 'border-zinc-600 bg-transparent'}`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 53,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: `text-xs font-medium ${armed ? 'text-emerald-300' : 'text-zinc-400'}`,
                        children: label
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 60,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: `ms-auto font-mono text-sm tabular-nums ${armed ? 'text-emerald-300' : 'text-zinc-300'}`,
                        children: value
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 61,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "w-16 text-right font-mono text-[10px] tabular-nums text-zinc-600",
                        children: [
                            "need ",
                            threshold,
                            unit
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 62,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 52,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "mt-1.5 h-1 overflow-hidden rounded bg-[#171b21]",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: `h-full rounded transition-[width] duration-150 ${armed ? 'bg-emerald-400' : 'bg-zinc-500/50'}`,
                    style: {
                        width: `${Math.min(Math.max(progress, 0), 1) * 100}%`
                    }
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 68,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 67,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 51,
        columnNumber: 5
    }, this);
}
_c1 = TriggerRow;
function SideHeader({ side, live }) {
    const up = side === 'UP';
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex items-center gap-1.5 pb-1 pt-1",
        children: [
            up ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowUp$3e$__["ArrowUp"], {
                className: "h-3 w-3 text-emerald-400"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 81,
                columnNumber: 13
            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$down$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowDown$3e$__["ArrowDown"], {
                className: "h-3 w-3 text-red-400"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 81,
                columnNumber: 64
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: `text-[10px] font-bold tracking-widest ${up ? 'text-emerald-300' : 'text-red-300'}`,
                children: [
                    side,
                    " SIDE"
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 82,
                columnNumber: 7
            }, this),
            up ? null : live ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[8px] font-bold text-red-300",
                children: "MIRRORED TRIGGER SET"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 86,
                columnNumber: 9
            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "rounded border border-zinc-600/40 bg-zinc-500/10 px-1 py-px text-[8px] font-bold text-zinc-500",
                children: "FIRING OFF (setting)"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 90,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 80,
        columnNumber: 5
    }, this);
}
_c2 = SideHeader;
function TriggerPanel() {
    _s();
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[focus]": (s)=>s.snapshot?.focus
    }["TriggerPanel.useXarb[focus]"]);
    const fv = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[fv]": (s)=>s.snapshot?.fv
    }["TriggerPanel.useXarb[fv]"]);
    const edge = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[edge]": (s)=>s.snapshot?.edge
    }["TriggerPanel.useXarb[edge]"]);
    const trig = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[trig]": (s)=>s.snapshot?.triggers
    }["TriggerPanel.useXarb[trig]"]);
    const dnTrig = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[dnTrig]": (s)=>s.snapshot?.dnTriggers
    }["TriggerPanel.useXarb[dnTrig]"]);
    const jumpT = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[jumpT]": (s)=>s.settings.jumpThreshC
    }["TriggerPanel.useXarb[jumpT]"]);
    const floorT = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[floorT]": (s)=>s.settings.fvFloorC
    }["TriggerPanel.useXarb[floorT]"]);
    const edgeT = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[edgeT]": (s)=>s.settings.edgeThreshC
    }["TriggerPanel.useXarb[edgeT]"]);
    const netT = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[netT]": (s)=>s.settings.minNetEdgeC
    }["TriggerPanel.useXarb[netT]"]);
    const sideDown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[sideDown]": (s)=>s.snapshot?.sideDown ?? true
    }["TriggerPanel.useXarb[sideDown]"]);
    const running = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TriggerPanel.useXarb[running]": (s)=>s.snapshot?.running ?? false
    }["TriggerPanel.useXarb[running]"]);
    const net = edge?.net ?? null;
    const dnNet = edge?.dnNet ?? null;
    const jump = fv?.jump5s ?? 0;
    const jumpDn = fv?.jump5sDown ?? 0;
    const fvUp = fv?.value ?? 50;
    const fvDn = fv?.valueDown ?? 50;
    const edgeUp = edge?.fvAsk ?? null;
    const edgeDn = edge?.dnFvAsk ?? null;
    const armedCount = trig ? [
        trig.jump,
        trig.above60,
        trig.gap
    ].filter(Boolean).length : 0;
    const dnArmedCount = dnTrig ? [
        dnTrig.jump,
        dnTrig.above60,
        dnTrig.gap
    ].filter(Boolean).length : 0;
    const fireUp = !!trig?.all && !!trig?.net;
    const fireDn = sideDown && !!dnTrig?.all && !!dnTrig?.net;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(PanelShell, {
        icon: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$activity$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Activity$3e$__["Activity"], {
            className: "h-3.5 w-3.5 text-emerald-400"
        }, void 0, false, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 127,
            columnNumber: 13
        }, void 0),
        title: `Trigger conditions · ${focus?.label ?? '—'}`,
        hint: running ? 'both sides · every tick' : 'engine stopped',
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "divide-y divide-[#181c22]",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SideHeader, {
                        side: "UP",
                        live: true
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 132,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "① FV jump in 5s",
                        value: `${jump >= 0 ? '+' : ''}${jump.toFixed(1)}¢`,
                        threshold: `${jumpT}`,
                        unit: "¢",
                        armed: !!trig?.jump,
                        progress: jump / jumpT
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 133,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "② FV above floor",
                        value: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(fvUp),
                        threshold: `${floorT}`,
                        unit: "¢",
                        armed: !!trig?.above60,
                        progress: fvUp / floorT
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 141,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "③ Edge vs PM ask",
                        value: edgeUp == null ? '—' : `${edgeUp >= 0 ? '+' : ''}${edgeUp.toFixed(1)}¢`,
                        threshold: `${edgeT}`,
                        unit: "¢",
                        armed: !!trig?.gap,
                        progress: (edgeUp ?? 0) / edgeT
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 149,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "④ Net edge after costs",
                        value: net == null ? '—' : `${net >= 0 ? '+' : ''}${net.toFixed(1)}¢`,
                        threshold: `${netT}`,
                        unit: "¢",
                        armed: !!trig?.net,
                        progress: (net ?? 0) / netT
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 157,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SideHeader, {
                        side: "DOWN",
                        live: sideDown
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 165,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "① FV jump in 5s",
                        value: `${jumpDn >= 0 ? '+' : ''}${jumpDn.toFixed(1)}¢`,
                        threshold: `${jumpT}`,
                        unit: "¢",
                        armed: !!dnTrig?.jump,
                        progress: jumpDn / jumpT,
                        dim: !sideDown
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 166,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "② FV above floor",
                        value: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(fvDn),
                        threshold: `${floorT}`,
                        unit: "¢",
                        armed: !!dnTrig?.above60,
                        progress: fvDn / floorT,
                        dim: !sideDown
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 175,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "③ Edge vs PM ask",
                        value: edgeDn == null ? '—' : `${edgeDn >= 0 ? '+' : ''}${edgeDn.toFixed(1)}¢`,
                        threshold: `${edgeT}`,
                        unit: "¢",
                        armed: !!dnTrig?.gap,
                        progress: (edgeDn ?? 0) / edgeT,
                        dim: !sideDown
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 184,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(TriggerRow, {
                        label: "④ Net edge after costs",
                        value: dnNet == null ? '—' : `${dnNet >= 0 ? '+' : ''}${dnNet.toFixed(1)}¢`,
                        threshold: `${netT}`,
                        unit: "¢",
                        armed: !!dnTrig?.net,
                        progress: (dnNet ?? 0) / netT,
                        dim: !sideDown
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 193,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "pb-1 pt-1 font-mono text-[9px] leading-relaxed text-zinc-600",
                        children: [
                            "④ = ③ − PM fee ",
                            (edge?.feeC ?? 0).toFixed(1),
                            "¢ − hedge cost ",
                            (edge?.hedgeCostC ?? 0).toFixed(1),
                            "¢ — fires only when the mispricing is profitable AFTER all modeled costs. DOWN rows mirror the same trigger set on the DOWN token (FV jump down, FV>floor, ask under FV)."
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 202,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 131,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: `mt-3 rounded-md border px-3 py-2 text-center text-[11px] font-semibold tracking-wide ${fireUp || fireDn ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.15)]' : trig?.all || dnTrig?.all ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-[#262b33] bg-[#141821] text-zinc-500'}`,
                children: fireUp || fireDn ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "animate-pulse",
                    children: [
                        "⚡ ",
                        fireUp ? 'UP' : '',
                        "$",
                        fireUp && fireDn ? ' + ' : '',
                        "$",
                        fireDn ? 'DOWN' : '',
                        " — PROFITABLE FIRE"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 218,
                    columnNumber: 11
                }, this) : trig?.all || dnTrig?.all ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "animate-pulse text-amber-300",
                    children: [
                        "⚡ ",
                        trig?.all ? 'UP' : '',
                        "$",
                        trig?.all && dnTrig?.all ? ' + ' : '',
                        "$",
                        dnTrig?.all ? 'DOWN' : '',
                        " armed · gated by costs (net ",
                        Math.max(net ?? -99, dnNet ?? -99).toFixed(1),
                        "¢ < ",
                        netT,
                        "¢)"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 222,
                    columnNumber: 11
                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    children: [
                        "waiting · UP ",
                        armedCount,
                        "/3 armed · DOWN ",
                        dnArmedCount,
                        "/3 armed"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 227,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 208,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 126,
        columnNumber: 5
    }, this);
}
_s(TriggerPanel, "Vtjd2swv62Ey83F1RgJgBmXfIJQ=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c3 = TriggerPanel;
// ─── order book ladder (focus market · UP ladder + DOWN top) ────────────────
const EMPTY_LEVELS = [];
function BookLadder() {
    _s1();
    const asks = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[asks]": (s)=>s.snapshot?.pm.asks ?? EMPTY_LEVELS
    }["BookLadder.useXarb[asks]"]);
    const bids = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[bids]": (s)=>s.snapshot?.pm.bids ?? EMPTY_LEVELS
    }["BookLadder.useXarb[bids]"]);
    const ask = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[ask]": (s)=>s.snapshot?.pm.ask ?? null
    }["BookLadder.useXarb[ask]"]);
    const bid = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[bid]": (s)=>s.snapshot?.pm.bid ?? null
    }["BookLadder.useXarb[bid]"]);
    const dnAsk = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[dnAsk]": (s)=>s.snapshot?.pm.dnAsk ?? null
    }["BookLadder.useXarb[dnAsk]"]);
    const dnBid = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[dnBid]": (s)=>s.snapshot?.pm.dnBid ?? null
    }["BookLadder.useXarb[dnBid]"]);
    const dnAskSize = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[dnAskSize]": (s)=>s.snapshot?.pm.dnAskSize ?? 0
    }["BookLadder.useXarb[dnAskSize]"]);
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[focus]": (s)=>s.snapshot?.focus
    }["BookLadder.useXarb[focus]"]);
    const lastPx = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[lastPx]": (s)=>s.snapshot?.feeds.polymarket.lastTradePx ?? null
    }["BookLadder.useXarb[lastPx]"]);
    const status = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[status]": (s)=>s.snapshot?.feeds.polymarket.status ?? 'connecting'
    }["BookLadder.useXarb[status]"]);
    const loaded = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[loaded]": (s)=>s.snapshot?.window.tokensLoaded ?? false
    }["BookLadder.useXarb[loaded]"]);
    const fvUp = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "BookLadder.useXarb[fvUp]": (s)=>s.snapshot?.fv.value ?? 50
    }["BookLadder.useXarb[fvUp]"]);
    const maxSize = Math.max(1, ...asks.map((l)=>l.s), ...bids.map((l)=>l.s));
    const spread = ask != null && bid != null ? ask - bid : null;
    const depthUsd = asks.reduce((a, l)=>a + l.p / 100 * l.s, 0);
    const Row = ({ p, s, side })=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "relative flex items-center justify-between px-2 py-[3px] font-mono text-[11px] tabular-nums",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: `absolute inset-y-0 ${side === 'ask' ? 'right-0 bg-red-500/10' : 'right-0 bg-emerald-500/10'}`,
                    style: {
                        width: `${s / maxSize * 100}%`
                    }
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 260,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: `relative ${side === 'ask' ? 'text-red-300' : 'text-emerald-300'}`,
                    children: [
                        p.toFixed(1),
                        "¢"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 264,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "relative text-zinc-500",
                    children: s >= 1000 ? `${(s / 1000).toFixed(1)}k` : s.toFixed(0)
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 265,
                    columnNumber: 7
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 259,
            columnNumber: 5
        }, this);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(PanelShell, {
        icon: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$book$2d$open$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__BookOpen$3e$__["BookOpen"], {
            className: "h-3.5 w-3.5 text-amber-400"
        }, void 0, false, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 271,
            columnNumber: 13
        }, void 0),
        title: `Polymarket CLOB · ${focus?.label ?? ''}`,
        hint: status === 'live' && loaded ? 'UP + DOWN tokens live' : status,
        children: asks.length + bids.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "py-8 text-center text-[11px] text-zinc-600",
            children: loaded ? 'waiting for book events…' : 'discovering window tokens…'
        }, void 0, false, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 276,
            columnNumber: 9
        }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "mb-2 grid grid-cols-2 gap-1.5",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "rounded border border-emerald-500/25 bg-emerald-500/[0.04] px-2 py-1.5 font-mono text-[10px] tabular-nums",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mb-0.5 text-[8px] font-bold tracking-widest text-emerald-400/80",
                                    children: "UP TOKEN"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 283,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex justify-between",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-red-300",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(ask)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/panels.tsx",
                                            lineNumber: 285,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-emerald-300",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(bid)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/panels.tsx",
                                            lineNumber: 286,
                                            columnNumber: 17
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 284,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mt-0.5 text-right text-[8px] text-zinc-600",
                                    children: [
                                        "FV ",
                                        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(fvUp)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 288,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 282,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "rounded border border-red-500/25 bg-red-500/[0.04] px-2 py-1.5 font-mono text-[10px] tabular-nums",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mb-0.5 text-[8px] font-bold tracking-widest text-red-400/80",
                                    children: "DOWN TOKEN"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 291,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex justify-between",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-red-300",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(dnAsk)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/panels.tsx",
                                            lineNumber: 293,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-emerald-300",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(dnBid)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/panels.tsx",
                                            lineNumber: 294,
                                            columnNumber: 17
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 292,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mt-0.5 text-right text-[8px] text-zinc-600",
                                    children: [
                                        "sz ",
                                        Math.round(dnAskSize),
                                        " · FV ",
                                        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(100 - fvUp)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/panels.tsx",
                                    lineNumber: 296,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 290,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 281,
                    columnNumber: 11
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex flex-col-reverse gap-0",
                    children: asks.slice(0, 5).map((l)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Row, {
                            p: l.p,
                            s: l.s,
                            side: "ask"
                        }, `a${l.p}`, false, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 303,
                            columnNumber: 15
                        }, this))
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 301,
                    columnNumber: 11
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "my-1.5 flex items-center justify-between rounded border border-[#262b33] bg-[#141821] px-2 py-1.5 font-mono text-[11px] tabular-nums",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-500",
                            children: [
                                "spread ",
                                spread != null ? `${spread.toFixed(1)}¢` : '—'
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 307,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-zinc-300",
                            children: lastPx != null ? `last ${(lastPx * 100).toFixed(1)}¢` : '—'
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 308,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 306,
                    columnNumber: 11
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex flex-col gap-0",
                    children: bids.slice(0, 5).map((l)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Row, {
                            p: l.p,
                            s: l.s,
                            side: "bid"
                        }, `b${l.p}`, false, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 312,
                            columnNumber: 15
                        }, this))
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 310,
                    columnNumber: 11
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "mt-2 flex justify-between font-mono text-[9px] text-zinc-600",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            children: [
                                "ask depth ≈ $",
                                depthUsd.toFixed(0)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 316,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            children: "fills walk this ladder"
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/panels.tsx",
                            lineNumber: 317,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/panels.tsx",
                    lineNumber: 315,
                    columnNumber: 11
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 280,
            columnNumber: 9
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 270,
        columnNumber: 5
    }, this);
}
_s1(BookLadder, "aQITIsbkSkLNfju5PoNJOoTk+xM=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c4 = BookLadder;
// ─── latency / performance ───────────────────────────────────────────────────
function LatRow({ label, value, note, ok }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex items-center gap-2 border-b border-[#181c22] py-1.5 last:border-0",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "w-[105px] shrink-0 text-[10px] text-zinc-500",
                children: label
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 330,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "font-mono text-xs tabular-nums text-zinc-200",
                children: value
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 331,
                columnNumber: 7
            }, this),
            ok ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px font-mono text-[9px] font-bold text-emerald-400",
                children: "sub-ms"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 333,
                columnNumber: 9
            }, this) : null,
            note ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "ms-auto text-[9px] text-zinc-600",
                children: note
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 337,
                columnNumber: 15
            }, this) : null
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 329,
        columnNumber: 5
    }, this);
}
_c5 = LatRow;
function LatencyPanel() {
    _s2();
    const lat = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "LatencyPanel.useXarb[lat]": (s)=>s.snapshot?.latency
    }["LatencyPanel.useXarb[lat]"]);
    const bin = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "LatencyPanel.useXarb[bin]": (s)=>s.snapshot?.feeds.binance
    }["LatencyPanel.useXarb[bin]"]);
    const pm = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "LatencyPanel.useXarb[pm]": (s)=>s.snapshot?.feeds.polymarket
    }["LatencyPanel.useXarb[pm]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "LatencyPanel.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["LatencyPanel.useXarb[marketsLive]"]);
    const marketsTotal = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "LatencyPanel.useXarb[marketsTotal]": (s)=>s.snapshot?.marketsTotal ?? 0
    }["LatencyPanel.useXarb[marketsTotal]"]);
    const decisionSubMs = (lat?.decisionUsP99 ?? 0) > 0 && (lat?.decisionUsP99 ?? 0) < 1000;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(PanelShell, {
        icon: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$gauge$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Gauge$3e$__["Gauge"], {
            className: "h-3.5 w-3.5 text-emerald-400"
        }, void 0, false, {
            fileName: "[project]/src/components/xarb/panels.tsx",
            lineNumber: 351,
            columnNumber: 23
        }, void 0),
        title: "Latency · measured live",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "binance feed",
                        value: `${bin?.latencyMs ?? 0}ms`,
                        note: `p50 ${lat?.feedP50 ?? 0} · p99 ${lat?.feedP99 ?? 0}ms`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 353,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "binance rate",
                        value: `${bin?.ticksPerMin ?? 0} tpm`,
                        note: `${bin?.symbols ?? 0} symbols combined WS`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 358,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "engine tick",
                        value: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtUs"])(lat?.engineUsP50 ?? 0),
                        note: `p99 ${(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtUs"])(lat?.engineUsP99 ?? 0)}`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 363,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "decision path",
                        value: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtUs"])(lat?.decisionUsP50 ?? 0),
                        note: `p99 ${(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtUs"])(lat?.decisionUsP99 ?? 0)}`,
                        ok: decisionSubMs
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 364,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "pm sockets",
                        value: `${pm?.sockets ?? 0} live`,
                        note: `${pm?.updates ?? 0} updates · ${pm?.status ?? '—'}`
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 370,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(LatRow, {
                        label: "universe",
                        value: `${marketsLive}/${marketsTotal} live`,
                        note: "both sides evaluated"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/panels.tsx",
                        lineNumber: 375,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 352,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "mt-2.5 text-[9px] leading-relaxed text-zinc-600",
                children: "One combined Binance socket feeds every symbol; each market owns a PM socket with both tokens. Local compute (event → signal) runs in microseconds — the network leg (~30ms) is the physical floor."
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/panels.tsx",
                lineNumber: 377,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/panels.tsx",
        lineNumber: 351,
        columnNumber: 5
    }, this);
}
_s2(LatencyPanel, "kjWMyiyvTpzmZCZGiUIRGixBm68=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c6 = LatencyPanel;
var _c, _c1, _c2, _c3, _c4, _c5, _c6;
__turbopack_context__.k.register(_c, "PanelShell");
__turbopack_context__.k.register(_c1, "TriggerRow");
__turbopack_context__.k.register(_c2, "SideHeader");
__turbopack_context__.k.register(_c3, "TriggerPanel");
__turbopack_context__.k.register(_c4, "BookLadder");
__turbopack_context__.k.register(_c5, "LatRow");
__turbopack_context__.k.register(_c6, "LatencyPanel");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/feeds.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "SignalFeed",
    ()=>SignalFeed,
    "TradeBlotter",
    ()=>TradeBlotter
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$list$2d$tree$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ListTree$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/list-tree.js [app-client] (ecmascript) <export default as ListTree>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$receipt$2d$text$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ReceiptText$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/receipt-text.js [app-client] (ecmascript) <export default as ReceiptText>");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
const ACTION_STYLE = {
    EXECUTED: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    SKIPPED: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    WATCH: 'border-zinc-600/50 bg-zinc-500/10 text-zinc-400',
    EXIT: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
};
const SIDE_STYLE = {
    UP: 'text-emerald-300',
    DOWN: 'text-red-300'
};
function SignalFeed() {
    _s();
    const signals = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "SignalFeed.useXarb[signals]": (s)=>s.signals
    }["SignalFeed.useXarb[signals]"]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex min-h-0 flex-col rounded-lg border border-[#22262e] bg-[#101318]",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$list$2d$tree$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ListTree$3e$__["ListTree"], {
                        className: "h-3.5 w-3.5 text-emerald-400"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 24,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-[11px] font-semibold uppercase tracking-widest text-zinc-400",
                        children: "Signal feed"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 25,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "ms-auto font-mono text-[9px] tabular-nums text-zinc-600",
                        children: [
                            signals.length,
                            " events"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 26,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/feeds.tsx",
                lineNumber: 23,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "xarb-scroll max-h-[340px] min-h-0 flex-1 overflow-y-auto p-2",
                children: signals.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "py-8 text-center text-[11px] text-zinc-600",
                    children: [
                        "scanning ",
                        11,
                        " markets · both sides · waiting for the first trigger event…"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/feeds.tsx",
                    lineNumber: 30,
                    columnNumber: 11
                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "space-y-1",
                    children: signals.map((s)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "rounded border border-[#1c2027] bg-[#12151b] px-2.5 py-2 transition-colors hover:border-[#2a3038]",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-2",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `rounded border px-1.5 py-px text-[9px] font-bold tracking-wider ${ACTION_STYLE[s.action]}`,
                                            children: s.action
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 41,
                                            columnNumber: 19
                                        }, this),
                                        s.marketLabel ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "rounded border border-[#2a3038] bg-[#181c22] px-1.5 py-px text-[9px] font-bold text-zinc-300",
                                            children: s.marketLabel
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 45,
                                            columnNumber: 21
                                        }, this) : null,
                                        s.side ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: `text-[10px] font-bold ${SIDE_STYLE[s.side]}`,
                                            children: s.side
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 49,
                                            columnNumber: 29
                                        }, this) : null,
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "font-mono text-[10px] tabular-nums text-zinc-500",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtClock"])(s.ts)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 50,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "ms-auto font-mono text-[10px] tabular-nums text-zinc-500",
                                            children: [
                                                "t−",
                                                Math.max(0, s.secondsLeft).toFixed(0),
                                                "s"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 51,
                                            columnNumber: 19
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                    lineNumber: 40,
                                    columnNumber: 17
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-zinc-300",
                                            children: [
                                                "FV ",
                                                (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(s.fv)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 56,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-amber-300/80",
                                            children: [
                                                "ask ",
                                                (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(s.ask)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 57,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: s.edge != null && s.edge > 0 ? 'text-emerald-400' : 'text-zinc-500',
                                            children: [
                                                "edge ",
                                                s.edge != null ? `${s.edge >= 0 ? '+' : ''}${s.edge.toFixed(1)}¢` : '—'
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 58,
                                            columnNumber: 19
                                        }, this),
                                        s.netEdgeC != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: s.netEdgeC >= 0 ? 'text-emerald-300' : 'text-red-300',
                                            children: [
                                                "net ",
                                                s.netEdgeC >= 0 ? '+' : '',
                                                s.netEdgeC.toFixed(1),
                                                "¢"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 62,
                                            columnNumber: 21
                                        }, this) : null,
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-zinc-500",
                                            children: [
                                                "jump ",
                                                s.jump5s >= 0 ? '+' : '',
                                                s.jump5s.toFixed(1),
                                                "¢"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 66,
                                            columnNumber: 19
                                        }, this),
                                        s.action === 'EXECUTED' && s.fillPrice != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-emerald-300",
                                            children: [
                                                "filled ",
                                                s.fillPrice.toFixed(1),
                                                "¢ × ",
                                                Math.round(s.shares ?? 0),
                                                "sh",
                                                s.sigmaEffPts != null ? ` · σ ${s.sigmaEffPts.toFixed(1)}` : ''
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 68,
                                            columnNumber: 21
                                        }, this) : null
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                    lineNumber: 55,
                                    columnNumber: 17
                                }, this),
                                s.reason ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mt-0.5 text-[10px] text-zinc-600",
                                    children: s.reason
                                }, void 0, false, {
                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                    lineNumber: 74,
                                    columnNumber: 29
                                }, this) : null
                            ]
                        }, s.id, true, {
                            fileName: "[project]/src/components/xarb/feeds.tsx",
                            lineNumber: 36,
                            columnNumber: 15
                        }, this))
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/feeds.tsx",
                    lineNumber: 34,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/feeds.tsx",
                lineNumber: 28,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/feeds.tsx",
        lineNumber: 22,
        columnNumber: 5
    }, this);
}
_s(SignalFeed, "QVZSGEfH1CAPfAzee69yjLWHRVU=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c = SignalFeed;
function TradeBlotter() {
    _s1();
    const trades = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TradeBlotter.useXarb[trades]": (s)=>s.trades
    }["TradeBlotter.useXarb[trades]"]);
    const staked = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TradeBlotter.useXarb[staked]": (s)=>s.snapshot?.stats.stakedUsd ?? 0
    }["TradeBlotter.useXarb[staked]"]);
    const open = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "TradeBlotter.useXarb[open]": (s)=>s.snapshot?.stats.open ?? 0
    }["TradeBlotter.useXarb[open]"]);
    const STATUS_STYLE = {
        OPEN: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
        WON: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
        LOST: 'border-red-500/50 bg-red-500/15 text-red-300',
        EXITED: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex min-h-0 flex-col rounded-lg border border-[#22262e] bg-[#101318]",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$receipt$2d$text$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ReceiptText$3e$__["ReceiptText"], {
                        className: "h-3.5 w-3.5 text-amber-400"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 99,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-[11px] font-semibold uppercase tracking-widest text-zinc-400",
                        children: "Trade blotter"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 100,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "ms-auto font-mono text-[9px] tabular-nums text-zinc-600",
                        children: [
                            trades.length,
                            " fills · ",
                            open,
                            " open · $",
                            staked.toFixed(0),
                            " staked"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/feeds.tsx",
                        lineNumber: 101,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/feeds.tsx",
                lineNumber: 98,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "xarb-scroll max-h-[340px] min-h-0 flex-1 overflow-auto",
                children: trades.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "py-8 text-center text-[11px] text-zinc-600",
                    children: "no fills yet · entries appear when all 3 triggers fire on any market"
                }, void 0, false, {
                    fileName: "[project]/src/components/xarb/feeds.tsx",
                    lineNumber: 107,
                    columnNumber: 11
                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("table", {
                    className: "w-full border-collapse text-left",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("thead", {
                            className: "sticky top-0 bg-[#101318]",
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tr", {
                                className: "text-[9px] uppercase tracking-wider text-zinc-600",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-3 py-1.5 font-medium",
                                        children: "time"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 114,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 font-medium",
                                        children: "market"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 115,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 font-medium",
                                        children: "side"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 116,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 font-medium",
                                        children: "fill"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 117,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 text-right font-medium",
                                        children: "net¢"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 118,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 text-right font-medium",
                                        children: "shares"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 119,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 text-right font-medium",
                                        children: "cost"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 120,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 text-right font-medium",
                                        children: "hedge"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 121,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-1.5 text-center font-medium",
                                        children: "status"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 122,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-3 py-1.5 text-right font-medium",
                                        children: "p&l"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/feeds.tsx",
                                        lineNumber: 123,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/feeds.tsx",
                                lineNumber: 113,
                                columnNumber: 15
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/feeds.tsx",
                            lineNumber: 112,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tbody", {
                            children: trades.map((t)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tr", {
                                    className: "border-t border-[#181c22] font-mono text-[11px] tabular-nums hover:bg-[#141821]",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-3 py-1.5 text-zinc-500",
                                            children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtClock"])(t.ts)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 129,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-zinc-300",
                                            children: t.marketLabel ?? t.market
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 130,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: `px-2 py-1.5 font-bold ${SIDE_STYLE[t.side] ?? 'text-zinc-400'}`,
                                            children: t.side ?? 'UP'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 131,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-zinc-200",
                                            children: [
                                                t.priceC.toFixed(1),
                                                "¢"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 132,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: `px-2 py-1.5 text-right ${t.netEdgeC == null ? 'text-zinc-600' : t.netEdgeC >= 0 ? 'text-emerald-400' : 'text-red-400'}`,
                                            children: t.netEdgeC == null ? '—' : `${t.netEdgeC >= 0 ? '+' : ''}${t.netEdgeC.toFixed(1)}`
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 133,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right text-zinc-400",
                                            children: Math.round(t.shares)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 140,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right text-zinc-400",
                                            children: [
                                                "$",
                                                t.costUsd.toFixed(2)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 141,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right text-zinc-500",
                                            children: [
                                                t.hedgeQtyBtc ? `${t.hedgeQtyBtc} ${t.hedgeAsset ?? 'BTC'}` : '—',
                                                t.hedgePnlUsd != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: t.hedgePnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400',
                                                    children: [
                                                        ' ',
                                                        t.hedgePnlUsd >= 0 ? '+' : '',
                                                        t.hedgePnlUsd.toFixed(2)
                                                    ]
                                                }, void 0, true, {
                                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                                    lineNumber: 145,
                                                    columnNumber: 23
                                                }, this) : null
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 142,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-center",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: `rounded border px-1.5 py-px text-[9px] font-bold tracking-wider ${STATUS_STYLE[t.status]} ${t.status === 'OPEN' ? 'animate-pulse' : ''}`,
                                                    children: t.status
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                                    lineNumber: 151,
                                                    columnNumber: 21
                                                }, this),
                                                t.exitPxC != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "ms-1 text-[9px] text-cyan-400/70",
                                                    children: [
                                                        "@",
                                                        t.exitPxC.toFixed(0),
                                                        "¢"
                                                    ]
                                                }, void 0, true, {
                                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                                    lineNumber: 159,
                                                    columnNumber: 23
                                                }, this) : null
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 150,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: `px-3 py-1.5 text-right ${t.pnlUsd == null ? 'text-zinc-600' : t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}`,
                                            children: t.pnlUsd == null ? 'open' : (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPnl"])(t.pnlUsd)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/feeds.tsx",
                                            lineNumber: 162,
                                            columnNumber: 19
                                        }, this)
                                    ]
                                }, t.id, true, {
                                    fileName: "[project]/src/components/xarb/feeds.tsx",
                                    lineNumber: 128,
                                    columnNumber: 17
                                }, this))
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/feeds.tsx",
                            lineNumber: 126,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/feeds.tsx",
                    lineNumber: 111,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/feeds.tsx",
                lineNumber: 105,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/feeds.tsx",
        lineNumber: 97,
        columnNumber: 5
    }, this);
}
_s1(TradeBlotter, "9sMRDznpu3gaQNWDsbX2zTu9gyA=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c1 = TradeBlotter;
var _c, _c1;
__turbopack_context__.k.register(_c, "SignalFeed");
__turbopack_context__.k.register(_c1, "TradeBlotter");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/xarb/universe.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "UniversePanel",
    ()=>UniversePanel
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
// ─── Market universe grid (v0.5) ──────────────────────────────────────────────
// Every Polymarket up/down series the engine tracks: window countdown, strike,
// spot, both FV sides, both asks, both edges, σ_eff (bp/√s), per-side trigger
// LEDs (jump · floor · gap · net), open positions. Click a row → detail panels
// follow that market (focus). Power toggle → enable/disable live.
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$earth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Globe2$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/earth.js [app-client] (ecmascript) <export default as Globe2>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$power$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Power$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/power.js [app-client] (ecmascript) <export default as Power>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$crosshair$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Crosshair$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/crosshair.js [app-client] (ecmascript) <export default as Crosshair>");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
/** Stable empty fallback (a fresh [] in a zustand selector loops useSyncExternalStore). */ const EMPTY_UNIVERSE = [];
function Led({ on, title }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        title: title,
        className: `inline-block h-[7px] w-[7px] shrink-0 rounded-full border ${on ? 'border-emerald-400 bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]' : 'border-zinc-700 bg-transparent'}`
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/universe.tsx",
        lineNumber: 18,
        columnNumber: 5
    }, this);
}
_c = Led;
function SideLeds({ t }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: "inline-flex items-center gap-[3px]",
        title: "jump · floor · gap · net",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Led, {
                on: t.jump,
                title: "① FV jump ≥ threshold"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 32,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Led, {
                on: t.above60,
                title: "② FV above floor"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 33,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Led, {
                on: t.gap,
                title: "③ edge vs ask"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 34,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Led, {
                on: t.net,
                title: "④ net edge after costs"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 35,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/universe.tsx",
        lineNumber: 31,
        columnNumber: 5
    }, this);
}
_c1 = SideLeds;
function StatusDot({ status }) {
    const cls = status === 'live' ? 'bg-emerald-400 animate-pulse' : status === 'loading' ? 'bg-amber-400' : status === 'down' ? 'bg-red-500' : 'bg-zinc-700';
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`
    }, void 0, false, {
        fileName: "[project]/src/components/xarb/universe.tsx",
        lineNumber: 49,
        columnNumber: 10
    }, this);
}
_c2 = StatusDot;
function UniversePanel() {
    _s();
    const universe = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[universe]": (s)=>s.snapshot?.universe ?? EMPTY_UNIVERSE
    }["UniversePanel.useXarb[universe]"]);
    const focusId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[focusId]": (s)=>s.snapshot?.focusId ?? 'btc-5m'
    }["UniversePanel.useXarb[focusId]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["UniversePanel.useXarb[marketsLive]"]);
    const marketsTotal = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[marketsTotal]": (s)=>s.snapshot?.marketsTotal ?? 0
    }["UniversePanel.useXarb[marketsTotal]"]);
    const sideDown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[sideDown]": (s)=>s.snapshot?.sideDown ?? true
    }["UniversePanel.useXarb[sideDown]"]);
    const capture = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[capture]": (s)=>s.snapshot?.capture
    }["UniversePanel.useXarb[capture]"]);
    const running = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "UniversePanel.useXarb[running]": (s)=>s.snapshot?.running ?? false
    }["UniversePanel.useXarb[running]"]);
    const opps = capture?.opportunities ?? 0;
    const fired = capture?.fired ?? 0;
    const gated = capture?.missed ?? 0;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
        "aria-label": "Market universe",
        className: "rounded-lg border border-[#22262e] bg-[#101318]",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex flex-wrap items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$earth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Globe2$3e$__["Globe2"], {
                        className: "h-3.5 w-3.5 text-cyan-400"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/universe.tsx",
                        lineNumber: 71,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-[11px] font-semibold uppercase tracking-widest text-zinc-400",
                        children: "Market universe"
                    }, void 0, false, {
                        fileName: "[project]/src/components/xarb/universe.tsx",
                        lineNumber: 72,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-px font-mono text-[9px] font-bold text-cyan-300",
                        children: [
                            marketsLive,
                            "/",
                            marketsTotal,
                            " LIVE"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/universe.tsx",
                        lineNumber: 75,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "font-mono text-[9px] tabular-nums text-zinc-600",
                        children: [
                            "opps ",
                            opps,
                            " · fired ",
                            fired,
                            " · gated ",
                            gated
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/universe.tsx",
                        lineNumber: 78,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "ms-auto hidden items-center gap-2 font-mono text-[9px] text-zinc-600 sm:flex",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$crosshair$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Crosshair$3e$__["Crosshair"], {
                                className: "h-3 w-3"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/universe.tsx",
                                lineNumber: 82,
                                columnNumber: 11
                            }, this),
                            "click a row to focus the panels · ",
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$power$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Power$3e$__["Power"], {
                                className: "h-3 w-3"
                            }, void 0, false, {
                                fileName: "[project]/src/components/xarb/universe.tsx",
                                lineNumber: 83,
                                columnNumber: 45
                            }, this),
                            " toggles the series",
                            sideDown ? ' · DOWN-side capture ON' : ' · DOWN-side capture OFF',
                            running ? '' : ' · engine STOPPED'
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/xarb/universe.tsx",
                        lineNumber: 81,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 70,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "xarb-scroll overflow-x-auto",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("table", {
                    className: "w-full min-w-[980px] border-collapse text-left",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("thead", {
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tr", {
                                className: "text-[9px] uppercase tracking-wider text-zinc-600",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2.5 py-2 font-medium",
                                        children: "market"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 93,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 font-medium",
                                        children: "window τ"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 94,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "strike K"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 95,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "spot"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 96,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "FV up / dn"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 97,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "ask up / dn"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 98,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "edge up / dn"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 99,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-right font-medium",
                                        children: "σ bp/√s"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 100,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-center font-medium",
                                        children: "①②③④ up"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 101,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2 py-2 text-center font-medium",
                                        children: "①②③④ dn"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 102,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("th", {
                                        className: "px-2.5 py-2 text-center font-medium",
                                        children: "pos"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                        lineNumber: 103,
                                        columnNumber: 15
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/components/xarb/universe.tsx",
                                lineNumber: 92,
                                columnNumber: 13
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/universe.tsx",
                            lineNumber: 91,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tbody", {
                            children: universe.map((u)=>{
                                const isFocus = u.id === focusId;
                                const prog = Math.min(Math.max(u.window.secondsLeft / u.windowSec, 0), 1);
                                const edgeUp = u.edge.fvAsk;
                                const edgeDn = u.edge.dnFvAsk;
                                const bestSide = edgeUp ?? -Infinity;
                                const dnSide = edgeDn ?? -Infinity;
                                const upHot = edgeUp != null && edgeUp >= 0;
                                const dnHot = edgeDn != null && edgeDn >= 0;
                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("tr", {
                                    onClick: ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["setFocusMarket"])(u.id),
                                    className: `cursor-pointer border-t border-[#181c22] font-mono text-[11px] tabular-nums transition-colors ${isFocus ? 'bg-cyan-500/[0.07] hover:bg-cyan-500/[0.1]' : 'hover:bg-[#141821]'} ${!u.enabled ? 'opacity-40' : ''}`,
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2.5 py-1.5",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "flex items-center gap-1.5",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                        "aria-label": u.enabled ? `Disable ${u.label}` : `Enable ${u.label}`,
                                                        title: u.enabled ? 'disable series (live)' : 'enable series (live)',
                                                        onClick: (e)=>{
                                                            e.stopPropagation();
                                                            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toggleMarket"])(u.id, !u.enabled);
                                                        },
                                                        className: `shrink-0 rounded p-0.5 transition-colors ${u.enabled ? 'text-emerald-400 hover:bg-emerald-500/15' : 'text-zinc-600 hover:bg-zinc-500/15'}`,
                                                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$power$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Power$3e$__["Power"], {
                                                            className: "h-3 w-3"
                                                        }, void 0, false, {
                                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                                            lineNumber: 139,
                                                            columnNumber: 25
                                                        }, this)
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 126,
                                                        columnNumber: 23
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(StatusDot, {
                                                        status: u.status
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 141,
                                                        columnNumber: 23
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: `text-[11px] font-semibold ${isFocus ? 'text-cyan-300' : 'text-zinc-200'}`,
                                                        children: u.label
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 142,
                                                        columnNumber: 23
                                                    }, this),
                                                    u.hedge.active ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        title: `δ-hedge open: ${u.hedge.qtyBtc} ${u.asset}`,
                                                        className: "rounded border border-fuchsia-500/40 bg-fuchsia-500/10 px-1 py-px text-[8px] font-bold text-fuchsia-300",
                                                        children: "Δ"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 146,
                                                        columnNumber: 25
                                                    }, this) : null,
                                                    u.triggers.all ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        title: "UP-side all-3 armed",
                                                        className: "rounded border border-emerald-500/50 bg-emerald-500/15 px-1 py-px text-[8px] font-bold text-emerald-300",
                                                        children: "UP"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 154,
                                                        columnNumber: 25
                                                    }, this) : null,
                                                    u.dnTriggers.all ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        title: "DOWN-side all-3 armed",
                                                        className: "rounded border border-red-500/50 bg-red-500/15 px-1 py-px text-[8px] font-bold text-red-300",
                                                        children: "DN"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 162,
                                                        columnNumber: 25
                                                    }, this) : null
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 125,
                                                columnNumber: 21
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 124,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "flex items-center gap-1.5",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: `w-8 text-[10px] ${u.window.secondsLeft < 30 ? 'text-red-400' : 'text-amber-300'}`,
                                                        children: u.enabled ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCountdown"])(u.window.secondsLeft) : '—'
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 173,
                                                        columnNumber: 23
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "hidden h-[3px] w-10 overflow-hidden rounded bg-[#1a1e25] md:block",
                                                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                            className: `block h-full rounded ${u.window.secondsLeft < 30 ? 'bg-red-400' : 'bg-amber-400/70'}`,
                                                            style: {
                                                                width: `${prog * 100}%`
                                                            }
                                                        }, void 0, false, {
                                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                                            lineNumber: 177,
                                                            columnNumber: 25
                                                        }, this)
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 176,
                                                        columnNumber: 23
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 172,
                                                columnNumber: 21
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 171,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right text-zinc-400",
                                            children: u.window.strike != null ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                children: [
                                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(u.window.strike, u.priceDp),
                                                    u.window.strikeEstimated ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "ms-1 align-middle text-[8px] font-bold text-amber-400/80",
                                                        children: "EST"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/xarb/universe.tsx",
                                                        lineNumber: 189,
                                                        columnNumber: 27
                                                    }, this) : null
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 186,
                                                columnNumber: 23
                                            }, this) : '—'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 184,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "text-zinc-200",
                                                    children: u.binance.price ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtPrice"])(u.binance.price, u.priceDp) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 197,
                                                    columnNumber: 21
                                                }, this),
                                                u.binance.change5s !== 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: `ms-1 text-[9px] ${u.binance.change5s > 0 ? 'text-emerald-400' : 'text-red-400'}`,
                                                    children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtSigned"])(u.binance.change5s, u.priceDp)
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 199,
                                                    columnNumber: 23
                                                }, this) : null
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 196,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: u.fv.value >= 60 ? 'text-emerald-300' : 'text-zinc-300',
                                                    children: u.enabled ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(u.fv.value, 0) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 205,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "mx-1 text-zinc-700",
                                                    children: "/"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 208,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: u.fv.valueDown >= 60 ? 'text-emerald-300' : 'text-zinc-500',
                                                    children: u.enabled ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(u.fv.valueDown, 0) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 209,
                                                    columnNumber: 21
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 204,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "text-amber-300/90",
                                                    children: u.pm.ask != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(u.pm.ask, 0) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 214,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "mx-1 text-zinc-700",
                                                    children: "/"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 215,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "text-amber-300/60",
                                                    children: u.pm.dnAsk != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtCents"])(u.pm.dnAsk, 0) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 216,
                                                    columnNumber: 21
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 213,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: upHot ? edgeUp >= 10 ? 'text-emerald-400' : 'text-emerald-300/70' : 'text-zinc-600',
                                                    children: edgeUp != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtSigned"])(edgeUp, 1) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 219,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "mx-1 text-zinc-700",
                                                    children: "/"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 222,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: sideDown && dnHot ? dnSide >= 10 ? 'text-emerald-400' : 'text-emerald-300/70' : 'text-zinc-600',
                                                    children: edgeDn != null ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fmtSigned"])(edgeDn, 1) : '—'
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                                    lineNumber: 223,
                                                    columnNumber: 21
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 218,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-right text-cyan-300/90",
                                            children: u.fv.sigmaEffBps ? u.fv.sigmaEffBps.toFixed(1) : '—'
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 235,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-center",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SideLeds, {
                                                t: u.triggers
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 237,
                                                columnNumber: 21
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 236,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2 py-1.5 text-center",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(SideLeds, {
                                                t: u.dnTriggers
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 240,
                                                columnNumber: 21
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 239,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("td", {
                                            className: "px-2.5 py-1.5 text-center",
                                            children: u.openPos > 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "rounded border border-zinc-500/40 bg-zinc-500/10 px-1.5 py-px text-[9px] font-bold text-zinc-200",
                                                children: u.openPos
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 244,
                                                columnNumber: 23
                                            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "text-zinc-700",
                                                children: "·"
                                            }, void 0, false, {
                                                fileName: "[project]/src/components/xarb/universe.tsx",
                                                lineNumber: 248,
                                                columnNumber: 23
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/xarb/universe.tsx",
                                            lineNumber: 242,
                                            columnNumber: 19
                                        }, this)
                                    ]
                                }, u.id, true, {
                                    fileName: "[project]/src/components/xarb/universe.tsx",
                                    lineNumber: 117,
                                    columnNumber: 17
                                }, this);
                            })
                        }, void 0, false, {
                            fileName: "[project]/src/components/xarb/universe.tsx",
                            lineNumber: 106,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/xarb/universe.tsx",
                    lineNumber: 90,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 89,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "border-t border-[#1c2027] px-3.5 py-2 font-mono text-[9px] leading-relaxed text-zinc-600",
                children: "both sides of every series evaluated on every tick — zero-miss trigger capture · σ shown in bp/√s (cross-asset comparable) · strike EST = engine joined mid-window"
            }, void 0, false, {
                fileName: "[project]/src/components/xarb/universe.tsx",
                lineNumber: 258,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/xarb/universe.tsx",
        lineNumber: 66,
        columnNumber: 5
    }, this);
}
_s(UniversePanel, "KX7x7Z/tuZa6SMtpQYFZKdmAogk=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c3 = UniversePanel;
var _c, _c1, _c2, _c3;
__turbopack_context__.k.register(_c, "Led");
__turbopack_context__.k.register(_c1, "SideLeds");
__turbopack_context__.k.register(_c2, "StatusDot");
__turbopack_context__.k.register(_c3, "UniversePanel");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Page
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/xarb.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$header$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/header.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$stat$2d$cards$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/stat-cards.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$charts$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/charts.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$panels$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/panels.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$feeds$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/feeds.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$universe$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/xarb/universe.tsx [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
;
function Legend({ color, label }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        className: "inline-flex items-center gap-1.5 text-[10px] text-zinc-500",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "h-[3px] w-3.5 rounded-full",
                style: {
                    background: color
                }
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 15,
                columnNumber: 7
            }, this),
            label
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 14,
        columnNumber: 5
    }, this);
}
_c = Legend;
function Page() {
    _s();
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Page.useEffect": ()=>{
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["connectEngine"])();
        }
    }["Page.useEffect"], []);
    const focus = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Page.useXarb[focus]": (s)=>s.snapshot?.focus
    }["Page.useXarb[focus]"]);
    const marketsLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Page.useXarb[marketsLive]": (s)=>s.snapshot?.marketsLive ?? 0
    }["Page.useXarb[marketsLive]"]);
    const marketsTotal = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Page.useXarb[marketsTotal]": (s)=>s.snapshot?.marketsTotal ?? 0
    }["Page.useXarb[marketsTotal]"]);
    const sideDown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"])({
        "Page.useXarb[sideDown]": (s)=>s.snapshot?.sideDown ?? true
    }["Page.useXarb[sideDown]"]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex min-h-screen flex-col bg-[#0b0d11] text-zinc-100",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$header$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Header"], {}, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 32,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
                className: "mx-auto w-full max-w-[1600px] flex-1 space-y-3 px-3 py-3 sm:px-5 sm:py-4",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$universe$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["UniversePanel"], {}, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 36,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$stat$2d$cards$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["StatCards"], {}, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 39,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                        "aria-label": "Sigma calibration, delta hedge and value capture",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$stat$2d$cards$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["V04Cards"], {}, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 43,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 42,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                        "aria-label": "Live charts",
                        className: "rounded-lg border border-[#22262e] bg-[#101318] p-3.5",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "mb-2 flex flex-wrap items-center gap-x-4 gap-y-1",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-[10px] font-semibold uppercase tracking-widest text-zinc-500",
                                        children: [
                                            focus?.label ?? 'BTC 5m',
                                            " · spot · window"
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 49,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#fb923c",
                                        label: "Binance mid"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 52,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#8b949e",
                                        label: "strike K"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 53,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "rgba(245,158,11,0.7)",
                                        label: "window end"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 54,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#10b981",
                                        label: "buy fill ▲"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 55,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "ms-auto hidden text-[10px] text-zinc-600 sm:block",
                                        children: "hover for crosshair · last 3 min"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 56,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 48,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$charts$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["PriceChart"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 58,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "my-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#1c2027] pt-2.5",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-[10px] font-semibold uppercase tracking-widest text-zinc-500",
                                        children: "UP fair value vs Polymarket ask"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 60,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#34d399",
                                        label: "FV (model)"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 63,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#fbbf24",
                                        label: "PM UP ask"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 64,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "#f87171",
                                        label: "FV floor"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 65,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {
                                        color: "rgba(16,185,129,0.25)",
                                        label: "positive edge"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 66,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 59,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$charts$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["FvChart"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 68,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 47,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "grid gap-3 lg:grid-cols-3",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$panels$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TriggerPanel"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 73,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$panels$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["BookLadder"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 74,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$panels$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LatencyPanel"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 75,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 72,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "grid gap-3 lg:grid-cols-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$feeds$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SignalFeed"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 80,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$xarb$2f$feeds$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TradeBlotter"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 81,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 79,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("footer", {
                        className: "rounded-lg border border-[#22262e] bg-[#101318] px-4 py-3 text-[10px] leading-relaxed text-zinc-600",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "font-semibold text-zinc-400",
                                        children: "Rule:"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 87,
                                        columnNumber: 13
                                    }, this),
                                    " on EVERY tick, for BOTH sides (UP and DOWN) of EVERY enabled market (",
                                    marketsLive,
                                    "/",
                                    marketsTotal,
                                    " series live",
                                    sideDown ? ' · DOWN capture on' : '',
                                    "): BUY the side when ① its fair value jumps ≥ 20¢ within 5s",
                                    ' ',
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-zinc-500",
                                        children: "AND"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 90,
                                        columnNumber: 13
                                    }, this),
                                    " ② its FV > 60¢ ",
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-zinc-500",
                                        children: "AND"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 90,
                                        columnNumber: 74
                                    }, this),
                                    " ③ the Polymarket ask on that side is ≥ 10¢ under fair value ",
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-zinc-500",
                                        children: "AND"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 91,
                                        columnNumber: 71
                                    }, this),
                                    " ④ the net edge (edge − PM taker fee − estimated Binance hedge cost) clears the floor — all in the same tick. FV = Φ((S−K)/(σ_eff·√T)) with σ_eff auto-calibrated from that market's live PM mids."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 86,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "mt-1",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "font-semibold text-zinc-400",
                                        children: "v0.5 universe engine:"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 96,
                                        columnNumber: 13
                                    }, this),
                                    " one combined Binance WS feeds all",
                                    ` ${marketsTotal}`,
                                    " series' underlyings; each market owns a Polymarket socket subscribed to BOTH tokens (real DOWN quotes + both-side σ calibration). Windows roll per series at their own cadence (5m/15m clock-aligned, Chainlink resolution). σ auto-calibration inverts the live PM mid (Φ⁻¹) into an implied σ per market, EWMA-fuses it with that asset's realized vol behind a dynamic median floor, and snap-pins FV to the market's own quote while it prints — the edge appears only in the reaction-lag window. Every fill is δ-hedged on the market's own Binance symbol (Whalley–Wilmott band, wind-down, force-flatten); early exits bank the mispricing when PM re-converges. Per-market + global capture accounting proves zero engine-missed episodes."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 95,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "mt-1",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "font-semibold text-zinc-400",
                                        children: "Notes:"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 107,
                                        columnNumber: 13
                                    }, this),
                                    " paper trading for research — no orders are sent; hedge fills cross the live Binance top-of-book in paper mode. Windows resolve on Chainlink oracles; this terminal settles paper positions on the Binance mid at close as a proxy, and strikes joined mid-window are marked EST. Live PM taker fee is folded into the net-edge gate. Not financial advice; check Polymarket eligibility & terms before trading real funds."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 106,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 85,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 34,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 31,
        columnNumber: 5
    }, this);
}
_s(Page, "cSQDzN91au7QOYHsqDRRF11XW2c=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$xarb$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useXarb"]
    ];
});
_c1 = Page;
var _c, _c1;
__turbopack_context__.k.register(_c, "Legend");
__turbopack_context__.k.register(_c1, "Page");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_3adff51c._.js.map