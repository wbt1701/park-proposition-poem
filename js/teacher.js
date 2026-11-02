// 교사 화면: 로그인 → 제출 목록 / 상세 / 숨기기·삭제 / CSV
(function () {
  const { $, $$, h, toast } = App;
  let sb = null;
  const state = { rows: [], pending: [], locations: [], assignments: [], sort: "sid", openId: null };

  function show(view) {
    $("#view-login").hidden = view !== "login";
    $("#view-main").hidden = view !== "main";
  }

  async function init() {
    if (App.configError) {
      const w = $("#setup-warning");
      w.textContent = App.configError;
      w.hidden = false;
      return;
    }
    // 학생 화면과 로그인 정보를 섞지 않도록 저장 키를 따로 씀
    sb = App.createClient("ppp-teacher-auth");
    bindEvents();
    const { data } = await sb.auth.getSession();
    if (data.session) await enter(true);
    else show("login");
  }

  function loginError(msg) {
    const err = $("#login-error");
    err.textContent = msg;
    err.hidden = false;
  }

  // 교사 계정 없이 비밀번호 하나로: 익명 로그인 → claim_teacher(비밀번호) 가 맞으면 12시간 교사 권한
  async function onLogin(e) {
    e.preventDefault();
    const btn = $("#login-submit");
    const password = $("#login-password").value;
    $("#login-error").hidden = true;
    if (!password) return loginError("비밀번호를 입력해 주세요.");
    btn.disabled = true;
    try {
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw error;
      }
      const { data: ok, error } = await sb.rpc("claim_teacher", { p_password: password });
      if (error) throw error;
      if (!ok) return loginError("비밀번호가 맞지 않습니다.");
      $("#login-password").value = "";
      await enter();
    } catch (error) {
      const msg = error.message || String(error);
      loginError(/anonymous sign-ins are disabled/i.test(msg)
        ? "Supabase에서 익명 로그인이 꺼져 있습니다. README 2단계를 확인하세요."
        : /rate limit|too many/i.test(msg) ? "시도가 너무 많습니다. 잠시 후 다시 해 주세요." : msg);
    } finally {
      btn.disabled = false;
    }
  }

  async function enter(silent) {
    const { data: isTeacher, error } = await sb.rpc("is_teacher");
    if (error || !isTeacher) {
      show("login");
      if (!silent) loginError(error ? error.message : "교사 권한을 얻지 못했습니다. 다시 로그인해 주세요.");
      return;
    }
    show("main");
    await load();
    subscribe();
  }

  // ---------------------------------------------------------------- 데이터
  async function load() {
    const [postsRes, authorsRes, countsRes, locRes, asgRes] = await Promise.all([
      sb.from("posts").select("*"),
      sb.from("authors").select("*"),
      sb.from("post_list").select("id,like_count"),
      sb.from("locations").select("*").order("id"),
      sb.from("assignments").select("*"),
    ]);
    const err = postsRes.error || authorsRes.error || countsRes.error || locRes.error || asgRes.error;
    if (err) return toast("불러오기 실패: " + err.message, true);

    state.locations = locRes.data;
    state.assignments = asgRes.data;
    const authorByUser = new Map(authorsRes.data.map((a) => [a.user_id, a]));
    const likeById = new Map(countsRes.data.map((c) => [c.id, c.like_count]));
    const asgByUser = new Map(asgRes.data.map((a) => [a.user_id, a]));
    const locById = new Map(locRes.data.map((l) => [l.id, l]));
    state.rows = postsRes.data.map((p) => {
      const a = authorByUser.get(p.user_id) || {};
      const asg = asgByUser.get(p.user_id) || null;
      return Object.assign({}, p, {
        student_id: a.student_id || "",
        name: a.name || "(정보 없음)",
        like_count: likeById.get(p.id) || 0,
        eligible: isEligible(p),
        asg,
        loc_name: asg && locById.get(asg.location_id) ? locById.get(asg.location_id).name : "",
      });
    });
    renderLocations();
    const posted = new Set(postsRes.data.map((p) => p.user_id));
    state.pending = authorsRes.data
      .filter((a) => !posted.has(a.user_id))
      .sort((a, b) => a.student_id.localeCompare(b.student_id));
    render();
    if (state.openId) openDetail(state.openId, true);
  }

  function sorted() {
    const rows = state.rows.slice();
    const bySid = (a, b) => (a.student_id || "99999").localeCompare(b.student_id || "99999");
    if (state.sort === "likes") rows.sort((a, b) => b.like_count - a.like_count || bySid(a, b));
    else if (state.sort === "time") rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    else rows.sort(bySid);
    return rows;
  }

  function fmtFull(iso) {
    return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // 서버 mission_eligible() 과 같은 기준: 숨기지 않음 + 사진 + 본문 5줄 이상(빈 줄 제외)
  function isEligible(p) {
    return !p.hidden && !!(p.photo_url || "").trim() && p.body.split(/\r?\n/).filter((l) => l.trim()).length >= 5;
  }
  const aiText = (v) => (v === true ? "사용" : v === false ? "안 함" : "-");
  const stop = (e) => e.stopPropagation();
  function missionText(r) {
    if (!r.asg) return r.eligible ? "대상 (아직 미션을 열지 않음)" : "대상 아님";
    return `${r.loc_name} · ` + (r.asg.found_at ? `획득 ${fmtFull(r.asg.found_at)}` : "찾는 중") +
      (r.asg.prize_given ? " · 상품 지급" : "");
  }

  // ---------------------------------------------------------------- 보물찾기: 학생별 장소·상품
  function locationSelect(r) {
    return h("select", {
      class: "loc-select", "aria-label": `${r.student_id} 배정 장소`,
      onclick: stop, onkeydown: stop, onchange: (e) => changeLocation(r, e.target.value),
    },
      h("option", { value: "" }, "미배정"),
      state.locations.map((l) =>
        h("option", { value: String(l.id), selected: !!r.asg && r.asg.location_id === l.id },
          l.name + (l.is_closed ? " (마감)" : ""))));
  }

  async function changeLocation(r, value) {
    const loc = state.locations.find((l) => String(l.id) === value);
    const msg = loc
      ? `${r.student_id} ${r.name} 학생의 장소를 '${loc.name}'(으)로 바꿀까요?\n(획득 기록은 지워지고 새 문제가 보입니다)`
      : `${r.student_id} ${r.name} 학생의 배정을 취소할까요?\n(획득 기록도 지워집니다)`;
    if (!confirm(msg)) return render();
    const { error } = loc
      ? await sb.from("assignments").upsert(
          { user_id: r.user_id, location_id: loc.id, found_at: null, assigned_at: new Date().toISOString() },
          { onConflict: "user_id" })
      : await sb.from("assignments").delete().eq("user_id", r.user_id);
    if (error) {
      toast("변경 실패: " + error.message, true);
      return render();
    }
    toast("배정 장소를 바꿨습니다.");
    await load();
  }

  async function setPrize(r, given) {
    const { error } = await sb.from("assignments").update({ prize_given: given }).eq("user_id", r.user_id);
    if (error) toast("저장 실패: " + error.message, true);
    else toast(given ? "상품 지급으로 표시했습니다." : "상품 지급 표시를 지웠습니다.");
    await load();
  }

  // ---------------------------------------------------------------- 보물찾기: 장소 관리 탭
  function renderLocations() {
    const grid = $("#loc-grid");
    grid.replaceChildren();
    for (const l of state.locations) {
      const mine = state.assignments.filter((a) => a.location_id === l.id);
      const input = h("input", { type: "text", value: l.confirm_code || "", maxlength: "20", placeholder: "확인 코드", "aria-label": l.name + " 확인 코드" });
      grid.append(h("div", { class: "loc-card" + (l.is_closed ? " closed" : "") },
        h("h3", {}, l.name, h("span", { class: "badge " + (l.is_closed ? "gray" : "true") }, l.is_closed ? "마감" : "진행 중")),
        h("div", { class: "loc-stats" },
          h("div", {}, h("b", {}, String(mine.length)), "배정된 학생"),
          h("div", {}, h("b", {}, String(mine.filter((a) => a.found_at).length)), "획득 성공")),
        h("div", { class: "loc-code-row" },
          input,
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => saveCode(l, input.value) }, "저장")),
        l.confirm_code ? null : h("p", { class: "hint", style: "margin:0 0 10px;color:var(--danger)" }, "아직 확인 코드가 없어요"),
        h("button", { type: "button", class: "btn btn-small btn-block" + (l.is_closed ? " btn-accent" : ""), onclick: () => toggleClosed(l) },
          l.is_closed ? "마감 풀기" : "마감"),
        h("details", {},
          h("summary", { class: "hint", style: "cursor:pointer;margin-top:10px" }, "문제 보기"),
          h("ul", { class: "loc-puzzle" }, (l.puzzle || []).map((s) => h("li", {}, `${s.emoji} ${s.animal}: “${s.text}”`))))));
    }
  }

  async function saveCode(l, raw) {
    const code = raw.trim().toUpperCase() || null;
    const { error } = await sb.from("locations").update({ confirm_code: code, updated_at: new Date().toISOString() }).eq("id", l.id);
    if (error) return toast(error.code === "23505" ? "다른 장소와 같은 코드예요. 다르게 정해 주세요." : "저장 실패: " + error.message, true);
    toast(`${l.name} 확인 코드를 저장했습니다.`);
    await load();
  }

  async function toggleClosed(l) {
    const { error } = await sb.from("locations").update({ is_closed: !l.is_closed, updated_at: new Date().toISOString() }).eq("id", l.id);
    if (error) return toast("변경 실패: " + error.message, true);
    toast(l.is_closed ? `${l.name} 마감을 풀었습니다.` : `${l.name}을(를) 마감했습니다.`);
    await load();
  }

  function showTab(tab) {
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#tab-list").hidden = tab !== "list";
    $("#tab-locations").hidden = tab !== "locations";
  }

  function render() {
    $$("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
    const hiddenCount = state.rows.filter((r) => r.hidden).length;
    $("#stats").textContent =
      `제출 ${state.rows.length}편` + (hiddenCount ? ` (숨김 ${hiddenCount})` : "") + ` · 미제출 ${state.pending.length}명`;

    const tbody = $("#rows");
    tbody.replaceChildren();
    if (!state.rows.length) {
      tbody.append(h("tr", {}, h("td", { colspan: "14", class: "empty-state" }, "아직 제출된 시가 없습니다.")));
    }
    for (const r of sorted()) {
      tbody.append(
        h("tr", { class: r.hidden ? "is-hidden" : "", tabindex: "0", onclick: () => openDetail(r.id),
                  onkeydown: (e) => e.key === "Enter" && openDetail(r.id) },
          h("td", {}, r.student_id),
          h("td", {}, r.name),
          h("td", { class: "title-cell" }, r.title),
          h("td", {}, h("span", { class: "badge " + (r.is_true ? "true" : "false") }, r.is_true ? "참" : "거짓")),
          h("td", {}, aiText(r.ai_used)),
          h("td", {}, "♥ " + r.like_count),
          h("td", {}, fmtFull(r.created_at)),
          h("td", {}, r.hidden ? h("span", { class: "badge gray" }, "숨김") : "공개"),
          h("td", {}, r.eligible ? "○" : "-"),
          h("td", {}, locationSelect(r)),
          h("td", {}, r.asg && r.asg.found_at ? h("span", { class: "badge true" }, "획득") : "-"),
          h("td", {}, r.asg && r.asg.found_at ? fmtFull(r.asg.found_at) : "-"),
          h("td", {}, h("input", {
            type: "checkbox", class: "prize-check", "aria-label": `${r.student_id} 상품 지급`,
            checked: !!(r.asg && r.asg.prize_given), disabled: !r.asg,
            onclick: stop, onkeydown: stop, onchange: (e) => setPrize(r, e.target.checked),
          })),
          h("td", {}, h("button", {
            type: "button", class: "btn btn-small",
            onclick: (e) => {
              e.stopPropagation(); // 행 클릭(상세 열기)과 구분
              downloadPdf(r, e.currentTarget);
            },
            onkeydown: (e) => e.stopPropagation(),
          }, "PDF"))));
    }

    $("#pending-summary").textContent = `입장했지만 아직 제출하지 않은 학생 (${state.pending.length}명)`;
    $("#pending-list").textContent = state.pending.length
      ? state.pending.map((a) => `${a.student_id} ${a.name}`).join(", ")
      : "없음";
  }

  // ---------------------------------------------------------------- 상세
  function openDetail(id, refreshOnly) {
    const r = state.rows.find((x) => x.id === id);
    const dlg = $("#detail");
    if (!r) {
      if (dlg.open) dlg.close();
      return;
    }
    state.openId = id;
    $("#dlg-title").textContent = `${r.student_id} ${r.name} — ${r.title}`;
    const used = r.used_sentences.map((k) => App.SENTENCE_LABELS[k] || k).join(", ");
    $("#dlg-body").replaceChildren(
      r.photo_url ? h("div", { class: "detail-photo" }, h("a", { href: r.photo_url, target: "_blank", rel: "noopener" },
        h("img", { src: r.photo_url, alt: "학생이 올린 사진" }))) : h("p", { class: "hint" }, "사진 없음"),
      h("dl", { class: "kv" },
        h("dt", {}, "p"), h("dd", {}, r.p),
        h("dt", {}, "q"), h("dd", {}, r.q),
        h("dt", {}, "원래 명제"), h("dd", {}, r.original + "  ",
          h("span", { class: "badge " + (r.is_true ? "true" : "false") }, r.is_true ? "참" : "거짓")),
        h("dt", {}, r.is_true ? "참인 이유" : "반례"), h("dd", {}, r.reason_or_counterexample),
        h("dt", {}, "역"), h("dd", {}, r.converse),
        h("dt", {}, "대우"), h("dd", {}, r.contrapositive),
        h("dt", {}, "사용한 문장"), h("dd", {}, used),
        h("dt", {}, "AI 사용"), h("dd", {}, aiText(r.ai_used)),
        h("dt", {}, "좋아요"), h("dd", {}, String(r.like_count)),
        h("dt", {}, "비밀 미션"), h("dd", {}, missionText(r)),
        h("dt", {}, "제출 / 수정"), h("dd", {}, fmtFull(r.created_at) + " / " + fmtFull(r.updated_at))),
      h("div", { class: "card soft" },
        h("h3", {}, r.title),
        h("p", { class: "poem-body" }, r.body)),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "btn btn-accent", onclick: (e) => downloadPdf(r, e.currentTarget) }, "PDF로 저장"),
        h("button", { type: "button", class: "btn", onclick: () => setHidden(r, !r.hidden) },
          r.hidden ? "다시 보이기" : "숨기기"),
        h("button", { type: "button", class: "btn btn-danger", onclick: () => removePost(r) }, "삭제"))
    );
    if (!refreshOnly && !dlg.open) dlg.showModal();
  }

  async function setHidden(r, hidden) {
    const { error } = await sb.from("posts").update({ hidden }).eq("id", r.id);
    if (error) return toast("변경 실패: " + error.message, true);
    toast(hidden ? "학생 갤러리에서 숨겼습니다." : "다시 보이게 했습니다.");
    await load();
  }

  async function removePost(r) {
    const ok = confirm(
      `정말 삭제할까요? 되돌릴 수 없습니다.\n\n${r.student_id} ${r.name} — 「${r.title}」\n(사진·좋아요도 함께 지워지고, 학생은 새로 쓸 수 있게 됩니다)`
    );
    if (!ok) return;
    const { error } = await sb.from("posts").delete().eq("id", r.id);
    if (error) return toast("삭제 실패: " + error.message, true);
    const path = App.photoPathFromUrl(r.photo_url);
    if (path) await sb.storage.from("photos").remove([path, App.thumbPath(path)]);
    $("#detail").close();
    state.openId = null;
    toast("삭제했습니다.");
    await load();
  }

  // ---------------------------------------------------------------- 학생별 PDF (사진 포함)
  const PDF_LIB = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.3/dist/html2pdf.bundle.min.js";
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.html2pdf) return Promise.resolve();
    pdfLibPromise = pdfLibPromise || new Promise((resolve, reject) => {
      const s = h("script", { src: PDF_LIB });
      s.onload = resolve;
      s.onerror = () => {
        pdfLibPromise = null;
        reject(new Error("PDF 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."));
      };
      document.head.append(s);
    });
    return pdfLibPromise;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = h("img", { crossorigin: "anonymous", alt: "" });
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function downloadPdf(r, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "PDF 만드는 중…";
    try {
      await loadPdfLib();
      const photo = r.photo_url ? await loadImage(r.photo_url) : null;
      const row = (k, v) => h("tr", {}, h("th", {}, k), h("td", {}, v));
      const sheet = h("div", { class: "pdf-sheet" },
        h("div", { class: "pdf-head" }, "공원에서 쓰는 명제 시"),
        h("div", { class: "pdf-who" }, `${r.student_id} ${r.name}`, h("span", {}, "제출 " + fmtFull(r.created_at))),
        photo ? h("div", { class: "pdf-photo" }, photo) : null,
        h("h1", {}, r.title),
        h("p", { class: "pdf-poem" }, r.body),
        h("table", { class: "pdf-notes" },
          row("p", r.p),
          row("q", r.q),
          row("원래 명제", `${r.original}  (${r.is_true ? "참" : "거짓"})`),
          row(r.is_true ? "참인 이유" : "반례", r.reason_or_counterexample),
          row("역", r.converse),
          row("대우", r.contrapositive),
          row("사용한 문장", r.used_sentences.map((k) => App.SENTENCE_LABELS[k] || k).join(", ")),
          row("AI 사용", aiText(r.ai_used)),
          row("좋아요", String(r.like_count))));
      const holder = h("div", { class: "pdf-holder" }, sheet);
      document.body.append(holder);
      const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
      try {
        await window.html2pdf()
          .set({
            margin: 10,
            filename: `${r.student_id}_${safe(r.name)}_${safe(r.title)}.pdf`,
            image: { type: "jpeg", quality: 0.92 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
            jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
            pagebreak: { mode: ["css", "legacy"], avoid: ["tr", ".pdf-photo", "h1"] },
          })
          .from(sheet)
          .save();
      } finally {
        holder.remove();
      }
    } catch (error) {
      toast("PDF 저장 실패: " + (error.message || error), true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------------------------------------------------------------- CSV
  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식으로 실행되지 않게
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    const header = ["학번", "이름", "시 제목", "시 본문", "p", "q", "원래 명제", "참·거짓", "이유 또는 반례",
                    "역", "대우", "사용한 문장", "AI 사용", "좋아요", "숨김", "제출 시각", "수정 시각",
                    "미션 대상", "배정 장소", "보물 획득", "획득 시각", "상품 지급"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of sorted()) {
      lines.push([
        r.student_id, r.name, r.title, r.body, r.p, r.q, r.original, r.is_true ? "참" : "거짓",
        r.reason_or_counterexample, r.converse, r.contrapositive,
        r.used_sentences.map((k) => App.SENTENCE_LABELS[k] || k).join(" / "),
        aiText(r.ai_used), r.like_count, r.hidden ? "숨김" : "",
        new Date(r.created_at).toLocaleString("ko-KR"), new Date(r.updated_at).toLocaleString("ko-KR"),
        r.eligible ? "대상" : "", r.loc_name, r.asg && r.asg.found_at ? "획득" : "",
        r.asg && r.asg.found_at ? new Date(r.asg.found_at).toLocaleString("ko-KR") : "",
        r.asg && r.asg.prize_given ? "지급" : "",
      ].map(csvCell).join(","));
    }
    // UTF-8 BOM(﻿) → 엑셀에서 한글이 깨지지 않음
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `명제시_제출목록_${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- 실시간
  let channel = null;
  let timer = null;
  function subscribe() {
    if (channel) return;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 500);
    };
    channel = sb
      .channel("teacher")
      .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, later)
      .on("postgres_changes", { event: "*", schema: "public", table: "likes" }, later)
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, later)
      .subscribe((status) => $("#live-dot").classList.toggle("on", status === "SUBSCRIBED"));
    setInterval(load, 60000); // 미제출 학생 목록(authors)은 실시간 대상이 아니라 주기적으로 갱신
  }

  function bindEvents() {
    $("#login-form").addEventListener("submit", onLogin);
    $("#logout-btn").addEventListener("click", async () => {
      await sb.rpc("release_teacher");
      await sb.auth.signOut();
      location.reload();
    });
    $$("[data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        state.sort = b.dataset.sort;
        render();
      })
    );
    $("#csv-btn").addEventListener("click", downloadCsv);
    $$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("#dlg-close").addEventListener("click", () => $("#detail").close());
    $("#detail").addEventListener("close", () => (state.openId = null));
  }

  init();
})();
