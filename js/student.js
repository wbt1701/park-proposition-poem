// 학생 화면: 입장 → 1~3단계 → 갤러리/상세
(function () {
  const { $, $$, h, toast } = App;
  const SCREENS = ["loading", "entry", "welcome", "step1", "step2", "step3", "gallery", "detail", "mission"];
  const STEPS = ["step1", "step2", "step3"];

  let sb = null;
  const state = {
    user: null,
    profile: null, // { sid, name } — 이 기기에만 저장
    draft: null,
    myPost: null,
    list: [],
    myLikes: new Set(),
    sort: "latest",
    currentPostId: null,
  };

  // ---------------------------------------------------------------- 공통
  const profileKey = () => "ppp-profile-" + state.user.id;
  const draftKey = () => "ppp-draft-" + state.user.id;

  function emptyDraft() {
    return {
      photoUrl: "", p: "", q: "", original: "", originalEdited: false,
      converse: "", contrapositive: "", isTrue: null, reasonTrue: "", counterexample: "",
      title: "", body: "", used: [], aiUsed: null,
    };
  }

  function draftFromPost(post) {
    return {
      photoUrl: post.photo_url || "", p: post.p, q: post.q, original: post.original,
      originalEdited: post.original !== App.makeProposition(post.p, post.q),
      converse: post.converse, contrapositive: post.contrapositive, isTrue: post.is_true,
      reasonTrue: post.is_true ? post.reason_or_counterexample : "",
      counterexample: post.is_true ? "" : post.reason_or_counterexample,
      title: post.title, body: post.body, used: post.used_sentences.slice(),
      aiUsed: typeof post.ai_used === "boolean" ? post.ai_used : null,
    };
  }

  function saveDraft() {
    App.writeJSON(draftKey(), state.draft);
  }

  function showScreen(name) {
    SCREENS.forEach((n) => ($("#screen-" + n).hidden = n !== name));
    const idx = STEPS.indexOf(name);
    $("#progress").hidden = idx < 0;
    $$("#progress li").forEach((li, i) => {
      li.classList.toggle("done", i < idx);
      li.classList.toggle("current", i === idx);
    });
    window.scrollTo(0, 0);
  }

  function go(hash) {
    if (location.hash === "#" + hash) route();
    else location.hash = hash;
  }

  function showErrors(boxId, errors) {
    const box = $("#" + boxId);
    box.replaceChildren();
    if (!errors.length) {
      box.hidden = true;
      return;
    }
    box.append(h("div", {}, "아직 채우지 않은 곳이 있어요."), h("ul", {}, errors.map((e) => h("li", {}, e))));
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function friendlyError(error) {
    const msg = (error && (error.message || error.error_description)) || String(error);
    if (/anonymous sign-ins are disabled/i.test(msg)) return "익명 로그인이 꺼져 있어요. 선생님께 알려 주세요.";
    if (/rate limit|too many/i.test(msg)) return "접속이 몰렸어요. 30초쯤 뒤에 다시 눌러 주세요.";
    if (/failed to fetch|network/i.test(msg)) return "인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.";
    return msg;
  }

  // ---------------------------------------------------------------- 라우터
  async function route() {
    const hash = location.hash.slice(1);
    if (!state.user || !state.profile) return renderEntry();

    if (hash === "step1") return renderStep1();
    if (hash === "step2") return step1Errors().length ? go("step1") : renderStep2();
    if (hash === "step3") {
      if (step1Errors().length) return go("step1");
      if (step2Errors().length) return go("step2");
      return renderStep3();
    }
    // 갤러리는 자기 시를 공유한 뒤에 볼 수 있음
    if (hash === "gallery") return state.myPost ? renderGallery() : go("step1");
    if (hash.startsWith("post/")) return state.myPost ? renderDetail(hash.slice(5)) : go("step1");
    if (hash === "mission") return state.myPost ? renderMission() : go("step1");
    if (hash === "welcome" && state.myPost) return renderWelcome();
    return go(state.myPost ? "welcome" : "step1");
  }

  // ---------------------------------------------------------------- 시작
  async function init() {
    if (App.configError) {
      const w = $("#setup-warning");
      w.textContent = App.configError;
      w.hidden = false;
      showScreen("entry");
      $("#entry-submit").disabled = true;
      return;
    }
    sb = App.createClient("ppp-student-auth");
    bindStaticEvents();

    const { data } = await sb.auth.getSession();
    if (data.session) await afterLogin(data.session.user);
    window.addEventListener("hashchange", route);
    route();
  }

  async function afterLogin(user) {
    state.user = user;
    state.profile = App.readJSON(profileKey());
    state.draft = Object.assign(emptyDraft(), App.readJSON(draftKey()) || {});
    if (state.profile) await loadMyPost();
    subscribeRealtime();
  }

  async function loadMyPost() {
    const { data, error } = await sb.from("posts").select("*").eq("user_id", state.user.id).maybeSingle();
    if (error) toast(friendlyError(error), true);
    state.myPost = data || null;
  }

  // ---------------------------------------------------------------- 입장
  function renderEntry() {
    showScreen("entry");
    $("#entry-error").hidden = true;
  }

  async function onEntrySubmit(e) {
    e.preventDefault();
    const sid = $("#entry-sid").value.trim();
    const name = $("#entry-name").value.trim();
    const err = $("#entry-error");
    $("#entry-sid").classList.toggle("invalid", !/^\d{5}$/.test(sid));
    $("#entry-name").classList.toggle("invalid", !name);
    if (!/^\d{5}$/.test(sid)) {
      err.textContent = "학번은 5자리 숫자로 입력해 주세요. 예) 10305";
      err.hidden = false;
      return;
    }
    if (!name) {
      err.textContent = "이름을 입력해 주세요.";
      err.hidden = false;
      return;
    }
    err.hidden = true;

    const btn = $("#entry-submit");
    btn.disabled = true;
    btn.textContent = "들어가는 중…";
    try {
      let user = state.user;
      if (!user) {
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw error;
        user = data.user;
      }
      const { error: rpcError } = await sb.rpc("register_author", { p_student_id: sid, p_name: name });
      if (rpcError) throw rpcError;
      App.writeJSON("ppp-profile-" + user.id, { sid, name });
      await afterLogin(user);
      go(state.myPost ? "welcome" : "step1");
    } catch (error) {
      err.textContent = friendlyError(error);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "시작하기";
    }
  }

  // ---------------------------------------------------------------- 다시 온 학생
  function renderWelcome() {
    showScreen("welcome");
    $("#welcome-who").textContent = `${state.profile.sid} ${state.profile.name} 학생, 반가워요.`;
  }

  function startEditing() {
    state.draft = draftFromPost(state.myPost);
    saveDraft();
    go("step1");
  }

  async function switchStudent() {
    const ok = confirm(
      "다른 학번으로 새로 입장할까요?\n이 기기에서 지금 학생의 시는 더 이상 고칠 수 없게 됩니다. (이미 공유한 시는 그대로 남아요)"
    );
    if (!ok) return;
    App.removeKey(draftKey());
    App.removeKey(profileKey());
    await sb.auth.signOut();
    location.hash = "";
    location.reload();
  }

  // ---------------------------------------------------------------- 1단계
  function fillInputs(screen) {
    $$("#screen-" + screen + " [data-field]").forEach((el) => {
      el.value = state.draft[el.dataset.field] || "";
      el.classList.remove("invalid");
    });
  }

  function renderStep1() {
    showScreen("step1");
    fillInputs("step1");
    renderPhoto();
    updateProposition();
    $("#step1-error").hidden = true;
  }

  function renderPhoto() {
    const box = $("#photo-box");
    box.replaceChildren();
    if (state.draft.photoUrl) {
      box.classList.add("has-photo");
      box.append(h("img", { src: state.draft.photoUrl, alt: "내가 올린 공원 사진" }));
    } else {
      box.classList.remove("has-photo");
      box.textContent = "사진을 찍거나 앨범에서 골라 주세요";
    }
  }

  function updateProposition() {
    const d = state.draft;
    const auto = App.makeProposition(d.p, d.q);
    if (!d.originalEdited) d.original = auto;
    const preview = $("#prop-preview");
    const wrap = $("#original-edit-wrap");
    if (d.original) {
      preview.textContent = d.original;
      preview.classList.remove("empty");
      wrap.hidden = false;
      if (document.activeElement !== $("#f-original")) $("#f-original").value = d.original;
    } else {
      preview.textContent = "p와 q를 쓰면 여기에 명제가 만들어져요.";
      preview.classList.add("empty");
      wrap.hidden = !d.originalEdited;
    }
    $("#original-reset").hidden = !d.originalEdited;
  }

  async function onPhotoPicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const status = $("#photo-status");
    try {
      status.textContent = "사진 크기를 줄이는 중…";
      const blob = await App.compressImage(file, 1280, 0.82);
      const thumb = await App.compressImage(file, App.THUMB_WIDTH, 0.75); // 갤러리 목록용 작은 사진
      status.textContent = `올리는 중… (${Math.round(blob.size / 1024)}KB)`;
      const path = `${state.user.id}/${Date.now()}.jpg`;
      const opts = { contentType: "image/jpeg", cacheControl: "3600", upsert: false };
      const { error } = await sb.storage.from("photos").upload(path, blob, opts);
      if (error) throw error;
      await sb.storage.from("photos").upload(App.thumbPath(path), thumb, opts); // 실패해도 목록에서 원본으로 대신 보여 줌
      state.draft.photoUrl = sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
      saveDraft();
      renderPhoto();
      status.textContent = "사진을 올렸어요 ✔";
    } catch (error) {
      status.textContent = "";
      toast("사진을 올리지 못했어요: " + friendlyError(error), true);
    }
  }

  function step1Errors() {
    const d = state.draft;
    const errors = [];
    if (!d.photoUrl) errors.push("공원 사진을 올려 주세요.");
    if (!d.p.trim()) errors.push("p를 써 주세요.");
    if (!d.q.trim()) errors.push("q를 써 주세요.");
    if (!d.original.trim()) errors.push("완성된 명제가 비어 있어요.");
    return errors;
  }

  // ---------------------------------------------------------------- 2단계
  function renderStep2() {
    showScreen("step2");
    fillInputs("step2");
    $("#step2-original").textContent = state.draft.original;
    renderTruth();
    $("#step2-error").hidden = true;
  }

  function renderTruth() {
    const v = state.draft.isTrue;
    $("#btn-true").setAttribute("aria-pressed", String(v === true));
    $("#btn-false").setAttribute("aria-pressed", String(v === false));
    $("#reason-true-wrap").hidden = v !== true;
    $("#reason-false-wrap").hidden = v !== false;
  }

  function step2Errors() {
    const d = state.draft;
    const errors = [];
    if (!d.converse.trim()) errors.push("역을 써 주세요.");
    if (!d.contrapositive.trim()) errors.push("대우를 써 주세요.");
    if (d.isTrue === null) errors.push("원래 명제가 참인지 거짓인지 골라 주세요.");
    if (d.isTrue === true && !d.reasonTrue.trim()) errors.push("참인 이유를 써 주세요.");
    if (d.isTrue === false && !d.counterexample.trim()) errors.push("반례를 써 주세요.");
    return errors;
  }

  // ---------------------------------------------------------------- 3단계
  function renderStep3() {
    showScreen("step3");
    fillInputs("step3");
    $("#ref-original").textContent = state.draft.original;
    $("#ref-converse").textContent = state.draft.converse;
    $("#ref-contrapositive").textContent = state.draft.contrapositive;
    $$('input[name="used"]').forEach((cb) => (cb.checked = state.draft.used.includes(cb.value)));
    renderAi();
    $("#submit-btn").textContent = state.myPost ? "고친 시 저장하기" : "공유하기";
    $("#step3-error").hidden = true;
  }

  function step3Errors() {
    const d = state.draft;
    const errors = [];
    if (!d.title.trim()) errors.push("제목을 써 주세요.");
    if (!d.body.trim()) errors.push("시를 써 주세요.");
    if (d.used.length < 2) errors.push("시에 사용한 문장을 2개 이상 골라 주세요.");
    if (d.aiUsed === null) errors.push("AI 사용 여부를 골라 주세요.");
    return errors;
  }

  function renderAi() {
    $("#ai-no").setAttribute("aria-pressed", String(state.draft.aiUsed === false));
    $("#ai-yes").setAttribute("aria-pressed", String(state.draft.aiUsed === true));
  }

  async function onSubmit() {
    const errors = [...step1Errors(), ...step2Errors(), ...step3Errors()];
    showErrors("step3-error", errors);
    if (errors.length) return;

    const d = state.draft;
    const row = {
      photo_url: d.photoUrl || null,
      p: d.p.trim(),
      q: d.q.trim(),
      original: d.original.trim(),
      converse: d.converse.trim(),
      contrapositive: d.contrapositive.trim(),
      is_true: d.isTrue,
      reason_or_counterexample: (d.isTrue ? d.reasonTrue : d.counterexample).trim(),
      title: d.title.trim(),
      body: d.body.replace(/\s+$/, ""),
      used_sentences: ["original", "converse", "contrapositive"].filter((k) => d.used.includes(k)),
      ai_used: d.aiUsed,
    };

    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = "저장하는 중…";
    try {
      let result;
      if (state.myPost) {
        result = await sb.from("posts").update(row).eq("id", state.myPost.id).select().single();
      } else {
        result = await sb.from("posts").insert(row).select().single();
        if (result.error && result.error.code === "23505") {
          // 다른 탭에서 이미 올린 경우 → 그 글을 고침
          await loadMyPost();
          result = await sb.from("posts").update(row).eq("id", state.myPost.id).select().single();
        }
      }
      if (result.error) throw result.error;
      const wasNew = !state.myPost;
      state.myPost = result.data;
      App.removeKey(draftKey());
      state.draft = emptyDraft();
      toast(wasNew ? "시를 공유했어요! 🎉" : "고친 시를 저장했어요.");
      go("gallery");
    } catch (error) {
      showErrors("step3-error", ["저장하지 못했어요: " + friendlyError(error)]);
    } finally {
      btn.disabled = false;
      btn.textContent = state.myPost ? "고친 시 저장하기" : "공유하기";
    }
  }

  // ---------------------------------------------------------------- 갤러리
  async function loadList() {
    const [listRes, likeRes] = await Promise.all([
      sb.from("post_list").select("id,user_id,title,hidden,created_at,like_count,photo_url"),
      sb.from("likes").select("post_id").eq("user_id", state.user.id),
    ]);
    if (listRes.error) return toast(friendlyError(listRes.error), true);
    state.list = listRes.data;
    state.myLikes = new Set((likeRes.data || []).map((r) => r.post_id));
  }

  function sortedList() {
    const list = state.list.slice();
    const byTime = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    if (state.sort === "likes") list.sort((a, b) => b.like_count - a.like_count || byTime(a, b));
    else if (state.sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, "ko") || byTime(a, b));
    else list.sort(byTime);
    return list;
  }

  async function renderGallery(skipLoad, fromRefresh) {
    showScreen("gallery");
    if (!skipLoad && !fromRefresh) checkMissionButton();
    if (!skipLoad) await loadList();
    $$(".sort-bar [data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
    const visible = state.list.filter((p) => !p.hidden);
    $("#gallery-count").textContent = `지금까지 ${visible.length}편이 공유되었어요.`;

    const ul = $("#poem-list");
    ul.replaceChildren();
    const items = sortedList();
    if (!items.length) {
      ul.append(h("li", { class: "empty-state" }, "아직 공유된 시가 없어요."));
      return;
    }
    for (const p of items) {
      const mine = p.user_id === state.user.id;
      ul.append(
        h("li", {},
          h("button", { type: "button", class: "poem-item" + (mine ? " mine" : ""), onclick: () => go("post/" + p.id) },
            h("span", { class: "thumb" }, p.photo_url ? App.thumbImg(p.photo_url, p.title + " 사진") : "🌳"),
            h("span", { class: "info" },
              h("span", { class: "title" }, p.title),
              h("span", { class: "meta" },
                mine ? h("span", { class: "badge" }, "내가 쓴 시") : null,
                p.hidden ? h("span", { class: "badge gray" }, "선생님이 숨김") : null,
                " ", App.formatTime(p.created_at))),
            h("span", { class: "likes", "aria-label": "좋아요 " + p.like_count + "개" },
              (state.myLikes.has(p.id) ? "♥ " : "♡ ") + p.like_count))));
    }
  }

  // ---------------------------------------------------------------- 상세
  async function renderDetail(id, skipScroll) {
    state.currentPostId = id;
    if (!skipScroll) showScreen("detail");
    const box = $("#detail-content");
    const [postRes, countRes, likeRes] = await Promise.all([
      sb.from("posts").select("*").eq("id", id).maybeSingle(),
      sb.from("post_list").select("like_count").eq("id", id).maybeSingle(),
      sb.from("likes").select("id").eq("post_id", id).eq("user_id", state.user.id).maybeSingle(),
    ]);
    if (state.currentPostId !== id) return;
    const post = postRes.data;
    if (!post) {
      box.replaceChildren(h("p", { class: "empty-state" }, "이 시를 찾을 수 없어요. (숨겨졌거나 지워졌을 수 있어요)"));
      return;
    }
    const mine = post.user_id === state.user.id;
    const liked = !!likeRes.data;
    const count = countRes.data ? countRes.data.like_count : 0;

    box.replaceChildren(
      post.photo_url ? h("div", { class: "detail-photo" }, h("img", { src: post.photo_url, alt: "시와 함께 올린 공원 사진" })) : null,
      h("div", { class: "card" },
        h("h2", { class: "poem-title" }, post.title),
        h("div", { class: "poet" }, mine ? h("span", { class: "badge" }, "내가 쓴 시") : "익명의 시인",
          post.hidden ? h("span", { class: "badge gray", style: "margin-left:6px" }, "선생님이 숨김") : null),
        h("p", { class: "poem-body" }, post.body),
        h("div", { class: "btn-row", style: "margin-top:18px" },
          h("button", {
            type: "button", class: "btn like-btn", "aria-pressed": String(liked), disabled: post.hidden,
            onclick: (e) => toggleLike(post.id, liked, e.currentTarget),
          }, (liked ? "♥ 좋아요 " : "♡ 좋아요 ") + count),
          mine ? h("button", { type: "button", class: "btn", onclick: startEditing }, "내 시 고치기") : null)),
      h("div", { class: "card soft" },
        h("h3", {}, "명제 노트"),
        h("ul", { class: "ref-list" },
          h("li", {}, h("span", { class: "prop-label" }, "원래 명제 ",
            h("span", { class: "badge " + (post.is_true ? "true" : "false") }, post.is_true ? "참" : "거짓")), post.original),
          h("li", {}, h("span", { class: "prop-label" }, post.is_true ? "참인 이유" : "반례"), post.reason_or_counterexample),
          h("li", {}, h("span", { class: "prop-label" }, "역"), post.converse),
          h("li", {}, h("span", { class: "prop-label" }, "대우"), post.contrapositive)))
    );
  }

  let liking = false;
  async function toggleLike(postId, liked, btn) {
    if (liking) return;
    liking = true;
    btn.disabled = true;
    const { error } = liked
      ? await sb.from("likes").delete().eq("post_id", postId).eq("user_id", state.user.id)
      : await sb.from("likes").insert({ post_id: postId });
    if (error && error.code !== "23505") toast("좋아요를 저장하지 못했어요: " + friendlyError(error), true);
    liking = false;
    await renderDetail(postId, true);
  }

  // ---------------------------------------------------------------- 보물찾기 비밀 미션
  // 조건(사진 + 본문 5줄 이상)은 서버 함수가 판단. 조건이 안 되면 버튼도 안내도 없음
  async function checkMissionButton() {
    const btn = $("#mission-open");
    const { data, error } = await sb.rpc("get_or_assign_mission", { p_assign: false });
    btn.hidden = !!error || !data || data.status === "ineligible";
  }

  const MISSION_INTRO = [
    "보물의 위치를 알고 있는 공원 동물 다섯 마리가 한마디씩 했다.",
    "이 중 정확히 두 마리는 거짓말을 하고, 나머지 세 마리는 진실을 말한다.",
    "보물은 놀이터, 정자, 운동기구, 화장실 건물, 인라인스케이트장 중 한 곳에 있다.",
  ];

  let missionBusy = false;
  async function renderMission() {
    showScreen("mission");
    const box = $("#mission-content");
    box.replaceChildren(h("p", { class: "empty-state" }, "미션을 불러오는 중…"));
    const { data, error } = await sb.rpc("get_or_assign_mission", { p_assign: true });
    if (error) {
      box.replaceChildren(h("div", { class: "error-box" }, "미션을 불러오지 못했어요: " + friendlyError(error)));
      return;
    }
    if (data.status === "ineligible") return go("gallery");
    if (data.status === "no_open") {
      box.replaceChildren(h("div", { class: "card soft empty-state" }, "지금은 진행 중인 보물이 없어요."));
      return;
    }
    if (data.status === "found") return renderMissionSuccess(box, data);

    const msg = h("div", { class: "mission-msg", hidden: true, "aria-live": "polite" });
    const input = h("input", {
      type: "text", class: "code-input", maxlength: "20", autocomplete: "off", autocapitalize: "characters",
      id: "mission-code", "aria-label": "확인 코드",
    });
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-block", style: "margin-top:10px" }, "확인");
    const form = h("form", { class: "card", novalidate: true },
      h("label", { class: "field-label", for: "mission-code" }, "보물을 찾았다면 봉투 안의 확인 코드를 입력하세요"),
      input, submit, msg);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      const show = (text, kind) => {
        msg.textContent = text;
        msg.className = "mission-msg " + kind;
        msg.hidden = false;
      };
      if (!code) return show("확인 코드를 입력해 주세요.", "warn");
      if (missionBusy) return;
      missionBusy = true;
      submit.disabled = true;
      const res = await sb.rpc("submit_confirm_code", { p_code: code });
      missionBusy = false;
      submit.disabled = false;
      if (res.error) return show(friendlyError(res.error), "bad");
      if (res.data === "success") return renderMission();
      if (res.data === "wrong_location") show("이 보물은 당신의 보물이 아니에요. 문제를 다시 풀어 보세요!", "warn");
      else show("코드를 다시 확인해 주세요.", "bad");
    });

    box.replaceChildren(
      h("h2", { class: "screen-title" }, "🎁 비밀 미션: 보물을 찾아라!"),
      h("div", { class: "card soft mission-intro" }, MISSION_INTRO.map((t) => h("p", {}, t))),
      h("ul", { class: "bubbles" },
        (data.puzzle || []).map((s) =>
          h("li", { class: "bubble" },
            h("div", { class: "who" }, h("span", { class: "face", "aria-hidden": "true" }, s.emoji), s.animal),
            h("div", { class: "say" }, `“${s.text}”`)))),
      form);
  }

  function renderMissionSuccess(box, data) {
    const t = new Date(data.found_at);
    const pad = (n) => String(n).padStart(2, "0");
    box.replaceChildren(
      h("div", { class: "success-screen" },
        h("p", { class: "big" }, "🎉 보물 획득 성공!"),
        h("div", { class: "sid-label" }, "학번 끝 두 자리"),
        h("div", { class: "sid" }, data.sid_tail || (state.profile && state.profile.sid.slice(-2)) || "--"),
        h("div", { class: "time" }, `획득 시각 ${t.getMonth() + 1}월 ${t.getDate()}일 ${pad(t.getHours())}:${pad(t.getMinutes())}`),
        h("div", { class: "show-teacher" }, "이 화면을 선생님께 보여 주세요")));
  }

  // ---------------------------------------------------------------- 실시간
  let channel = null;
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshCurrent, 400);
  }
  function refreshCurrent() {
    if (!$("#screen-gallery").hidden) renderGallery(false, true);
    else if (!$("#screen-detail").hidden && state.currentPostId && !liking) renderDetail(state.currentPostId, true);
  }

  function subscribeRealtime() {
    if (channel) return;
    channel = sb
      .channel("gallery")
      .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "likes" }, scheduleRefresh)
      .subscribe((status) => {
        const dot = $("#live-dot");
        if (dot) dot.classList.toggle("on", status === "SUBSCRIBED");
      });
    // 실시간이 끊겼을 때를 대비해 30초마다, 그리고 화면에 다시 돌아왔을 때 새로고침
    setInterval(refreshCurrent, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshCurrent();
    });
  }

  // ---------------------------------------------------------------- 이벤트 연결
  function bindStaticEvents() {
    $("#entry-form").addEventListener("submit", onEntrySubmit);
    $("#entry-sid").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5)));

    // 입력하면 바로 임시 저장 → [이전]으로 돌아가도, 새로고침해도 그대로
    $$("[data-field]").forEach((el) =>
      el.addEventListener("input", () => {
        state.draft[el.dataset.field] = el.value;
        el.classList.remove("invalid");
        if (el.dataset.field === "p" || el.dataset.field === "q") updateProposition();
        saveDraft();
      })
    );
    $("#f-original").addEventListener("input", (e) => {
      state.draft.original = e.target.value;
      state.draft.originalEdited = true;
      updateProposition();
      saveDraft();
    });
    $("#original-reset").addEventListener("click", () => {
      state.draft.originalEdited = false;
      $("#f-original").value = "";
      updateProposition();
      saveDraft();
    });

    $("#photo-camera").addEventListener("change", onPhotoPicked);
    $("#photo-album").addEventListener("change", onPhotoPicked);

    $("#step1-next").addEventListener("click", () => {
      const errors = step1Errors();
      showErrors("step1-error", errors);
      if (!errors.length) go("step2");
    });
    $("#btn-true").addEventListener("click", () => {
      state.draft.isTrue = true;
      saveDraft();
      renderTruth();
    });
    $("#btn-false").addEventListener("click", () => {
      state.draft.isTrue = false;
      saveDraft();
      renderTruth();
    });
    $("#step2-next").addEventListener("click", () => {
      const errors = step2Errors();
      showErrors("step2-error", errors);
      if (!errors.length) go("step3");
    });
    $$('input[name="used"]').forEach((cb) =>
      cb.addEventListener("change", () => {
        state.draft.used = $$('input[name="used"]:checked').map((c) => c.value);
        saveDraft();
      })
    );
    $("#ai-no").addEventListener("click", () => {
      state.draft.aiUsed = false;
      saveDraft();
      renderAi();
    });
    $("#ai-yes").addEventListener("click", () => {
      state.draft.aiUsed = true;
      saveDraft();
      renderAi();
    });
    $("#submit-btn").addEventListener("click", onSubmit);
    $("#mission-open").addEventListener("click", () => go("mission"));

    $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
    $$(".sort-bar [data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        state.sort = b.dataset.sort;
        renderGallery(true);
      })
    );

    $("#welcome-view").addEventListener("click", () => go("post/" + state.myPost.id));
    $("#welcome-edit").addEventListener("click", startEditing);
    $("#welcome-gallery").addEventListener("click", () => go("gallery"));
    $("#welcome-switch").addEventListener("click", switchStudent);
    $("#gallery-mine").addEventListener("click", () => go("welcome"));
  }

  init();
})();
