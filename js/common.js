// 학생·교사 화면이 함께 쓰는 도구 모음
(function () {
  const cfg = window.APP_CONFIG || {};
  const App = (window.App = {});

  // ---------- 설정 확인 ----------
  function keyRole(key) {
    if (key.startsWith("sb_secret_")) return "service_role";
    if (key.startsWith("sb_publishable_")) return "anon";
    try {
      const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.role || "";
    } catch (e) {
      return "";
    }
  }

  App.configError = (function () {
    const url = (cfg.SUPABASE_URL || "").trim();
    const key = (cfg.SUPABASE_ANON_KEY || "").trim();
    if (!url || !key) return "config.js 에 Supabase 주소와 anon 키를 넣어 주세요.";
    if (!/^https:\/\//.test(url)) return "config.js 의 SUPABASE_URL 은 https:// 로 시작해야 합니다.";
    if (keyRole(key) === "service_role")
      return "config.js 에 service_role(비밀) 키가 들어 있습니다. 즉시 지우고 anon 키를 넣으세요.";
    if (typeof window.supabase === "undefined")
      return "Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.";
    return "";
  })();

  App.createClient = function (storageKey) {
    return window.supabase.createClient(cfg.SUPABASE_URL.trim(), cfg.SUPABASE_ANON_KEY.trim(), {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey },
    });
  };

  // ---------- DOM ----------
  App.$ = (sel, root) => (root || document).querySelector(sel);
  App.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // h("div", {class: "x", onclick: fn}, "글자", childNode ...) — 글자는 항상 textContent 로 넣음
  App.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  let toastTimer;
  App.toast = function (msg, isError) {
    const t = App.$("#toast");
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 4500 : 2500);
  };

  App.readJSON = function (key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (e) {
      return null;
    }
  };
  App.writeJSON = function (key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  };
  App.removeKey = function (key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  };

  App.formatTime = function (iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  App.SENTENCE_LABELS = { original: "원래 명제", converse: "역", contrapositive: "대우" };

  // ---------- 한국어: "p이면 q이다" 만들기 ----------
  const HANGUL_BASE = 0xac00;
  const isHangul = (ch) => ch >= "가" && ch <= "힣";
  const jong = (ch) => (ch.charCodeAt(0) - HANGUL_BASE) % 28; // 0 = 받침 없음
  const withJong = (ch, j) => String.fromCharCode(ch.charCodeAt(0) - jong(ch) + j);
  const J = { N: 4, L: 8, B: 17, SS: 20 }; // ㄴ ㄹ ㅂ ㅆ
  const REGULAR_B = ["좁", "잡", "입", "씹", "업", "뽑", "굽", "접", "집"];

  // "낙엽이 떨어진다" → "낙엽이 떨어지면", "가을이다" → "가을이면"
  App.toConditional = function (p) {
    let s = (p || "").trim().replace(/[.。!?]+$/, "");
    if (!s) return "";
    if (s.endsWith("는다") && s.length > 2) return s.slice(0, -2) + "으면"; // 먹는다 → 먹으면
    if (s.endsWith("다") && s.length > 1) {
      const stem = s.slice(0, -1);
      const last = stem.slice(-1);
      if (!isHangul(last)) return stem + "면";
      const j = jong(last);
      if (j === 0 || j === J.L) return stem + "면"; // 크다 → 크면, 가을이다 → 가을이면, 알다 → 알면
      if (j === J.N) return stem.slice(0, -1) + withJong(last, 0) + "면"; // 진다 → 지면, 한다 → 하면
      if (j === J.B && !REGULAR_B.includes(last)) return stem.slice(0, -1) + withJong(last, 0) + "우면"; // 춥다 → 추우면
      return stem + "으면"; // 많다 → 많으면, 있다 → 있으면, 왔다 → 왔으면
    }
    const last = s.slice(-1);
    return s + (isHangul(last) && jong(last) !== 0 ? "이면" : "면");
  };

  App.makeProposition = function (p, q) {
    const cond = App.toConditional(p);
    const tail = (q || "").trim().replace(/[.。]+$/, "");
    if (!cond || !tail) return "";
    return `${cond} ${tail}.`;
  };

  // ---------- 사진 줄이기: 가로 maxW 이하 JPEG ----------
  App.compressImage = function (file, maxW, quality) {
    maxW = maxW || 1280;
    quality = quality || 0.82;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // 투명 PNG 가 검게 나오지 않도록
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("사진을 줄이지 못했어요."))), "image/jpeg", quality);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("이 사진 형식은 열 수 없어요. 다른 사진을 골라 주세요."));
      };
      img.src = url;
    });
  };

  // 공개 사진 주소 → 버킷 안 경로 ("<uid>/123.jpg")
  App.photoPathFromUrl = function (url) {
    const m = /\/storage\/v1\/object\/public\/photos\/(.+)$/.exec(url || "");
    return m ? decodeURIComponent(m[1].split("?")[0]) : null;
  };
})();
