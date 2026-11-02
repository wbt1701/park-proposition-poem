// 교사 화면: 로그인 → 제출 목록 / 상세 / 숨기기·삭제 / CSV
(function () {
  const { $, $$, h, toast } = App;
  let sb = null;
  const state = { rows: [], pending: [], sort: "sid", openId: null };

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
    const [postsRes, authorsRes, countsRes] = await Promise.all([
      sb.from("posts").select("*"),
      sb.from("authors").select("*"),
      sb.from("post_list").select("id,like_count"),
    ]);
    const err = postsRes.error || authorsRes.error || countsRes.error;
    if (err) return toast("불러오기 실패: " + err.message, true);

    const authorByUser = new Map(authorsRes.data.map((a) => [a.user_id, a]));
    const likeById = new Map(countsRes.data.map((c) => [c.id, c.like_count]));
    state.rows = postsRes.data.map((p) => {
      const a = authorByUser.get(p.user_id) || {};
      return Object.assign({}, p, {
        student_id: a.student_id || "",
        name: a.name || "(정보 없음)",
        like_count: likeById.get(p.id) || 0,
      });
    });
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

  function render() {
    $$("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
    const hiddenCount = state.rows.filter((r) => r.hidden).length;
    $("#stats").textContent =
      `제출 ${state.rows.length}편` + (hiddenCount ? ` (숨김 ${hiddenCount})` : "") + ` · 미제출 ${state.pending.length}명`;

    const tbody = $("#rows");
    tbody.replaceChildren();
    if (!state.rows.length) {
      tbody.append(h("tr", {}, h("td", { colspan: "7", class: "empty-state" }, "아직 제출된 시가 없습니다.")));
    }
    for (const r of sorted()) {
      tbody.append(
        h("tr", { class: r.hidden ? "is-hidden" : "", tabindex: "0", onclick: () => openDetail(r.id),
                  onkeydown: (e) => e.key === "Enter" && openDetail(r.id) },
          h("td", {}, r.student_id),
          h("td", {}, r.name),
          h("td", { class: "title-cell" }, r.title),
          h("td", {}, h("span", { class: "badge " + (r.is_true ? "true" : "false") }, r.is_true ? "참" : "거짓")),
          h("td", {}, "♥ " + r.like_count),
          h("td", {}, fmtFull(r.created_at)),
          h("td", {}, r.hidden ? h("span", { class: "badge gray" }, "숨김") : "공개")));
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
        h("dt", {}, "좋아요"), h("dd", {}, String(r.like_count)),
        h("dt", {}, "제출 / 수정"), h("dd", {}, fmtFull(r.created_at) + " / " + fmtFull(r.updated_at))),
      h("div", { class: "card soft" },
        h("h3", {}, r.title),
        h("p", { class: "poem-body" }, r.body)),
      h("div", { class: "btn-row" },
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
    if (path) await sb.storage.from("photos").remove([path]);
    $("#detail").close();
    state.openId = null;
    toast("삭제했습니다.");
    await load();
  }

  // ---------------------------------------------------------------- CSV
  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식으로 실행되지 않게
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    const header = ["학번", "이름", "시 제목", "시 본문", "p", "q", "원래 명제", "참·거짓", "이유 또는 반례",
                    "역", "대우", "사용한 문장", "좋아요", "숨김", "사진 주소", "제출 시각", "수정 시각"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of sorted()) {
      lines.push([
        r.student_id, r.name, r.title, r.body, r.p, r.q, r.original, r.is_true ? "참" : "거짓",
        r.reason_or_counterexample, r.converse, r.contrapositive,
        r.used_sentences.map((k) => App.SENTENCE_LABELS[k] || k).join(" / "),
        r.like_count, r.hidden ? "숨김" : "", r.photo_url || "",
        new Date(r.created_at).toLocaleString("ko-KR"), new Date(r.updated_at).toLocaleString("ko-KR"),
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
    $("#dlg-close").addEventListener("click", () => $("#detail").close());
    $("#detail").addEventListener("close", () => (state.openId = null));
  }

  init();
})();
