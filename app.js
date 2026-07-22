(() => {
  "use strict";

  const DB_NAME = "word-study-app-db";
  const DB_VERSION = 1;
  const STORE_NAME = "appState";
  const RECORD_KEY = "main";
  const LEGACY_STORAGE_KEYS = ["custom-word-study-app-v1", "custom-word-study-app-v2"];
  const APP_DATA_VERSION = 4;
  const BACKUP_CHANGE_THRESHOLD = 50;
  const BACKUP_DAY_THRESHOLD = 30;
  const BACKUP_SNOOZE_DAYS = 7;
  const NOTIFICATION_CHECK_INTERVAL_MS = 30000;

  let database = null;
  let saveQueue = Promise.resolve();
  let deferredInstallPrompt = null;
  let notificationTimer = null;

  const state = {
    words: [],
    meta: createDefaultMeta(),
    currentQuizWordId: null,
    currentDirection: "en-ja",
    answered: false,
    filteredQuizIds: [],
    quizSessionIds: [],
    quizSessionIndex: 0,
    quizSessionComplete: false,
    manualJudgePending: false,
    quizRangeOverride: null,
    quizSetupMode: "standard",
    pendingRegistration: null,
    pendingBulkSpellWarnings: []
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function createDefaultMeta() {
    const now = new Date().toISOString();
    return {
      firstUsedAt: now,
      lastSavedAt: null,
      lastBackupAt: null,
      changesSinceBackup: 0,
      backupReminderDismissedAt: null,
      storagePersisted: null,
      migratedFromLocalStorage: false,
      notificationEnabled: false,
      notificationTimes: [],
      notificationSent: {},
      answerHistory: []
    };
  }

  function normalizeMeta(meta) {
    const defaults = createDefaultMeta();
    return {
      ...defaults,
      ...(meta && typeof meta === "object" ? meta : {}),
      changesSinceBackup: Number.isFinite(meta?.changesSinceBackup)
        ? Math.max(0, meta.changesSinceBackup)
        : 0,
      storagePersisted: typeof meta?.storagePersisted === "boolean"
        ? meta.storagePersisted
        : null,
      notificationEnabled: meta?.notificationEnabled === true,
      notificationTimes: Array.isArray(meta?.notificationTimes)
        ? [...new Set(meta.notificationTimes.filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))))].sort().slice(0, 3)
        : [],
      notificationSent: meta?.notificationSent && typeof meta.notificationSent === "object"
        ? { ...meta.notificationSent }
        : {},
      answerHistory: Array.isArray(meta?.answerHistory)
        ? meta.answerHistory.map((entry) => {
            if (typeof entry === "string") return { date: entry, result: "unknown" };
            return {
              date: String(entry?.date || ""),
              result: ["correct", "wrong", "revealed", "unknown"].includes(entry?.result) ? entry.result : "unknown"
            };
          }).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date)).slice(-10000)
        : []
    };
  }

  function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeWord(word) {
    return {
      id: String(word?.id || generateId()),
      english: String(word?.english || "").trim(),
      japanese: String(word?.japanese || "").trim(),
      correct: Number.isFinite(word?.correct) ? Math.max(0, word.correct) : 0,
      mistakes: Number.isFinite(word?.mistakes) ? Math.max(0, word.mistakes) : 0,
      mistakeHistory: Array.isArray(word?.mistakeHistory)
        ? word.mistakeHistory.filter(Boolean).map(String)
        : [],
      reviewDates: Array.isArray(word?.reviewDates)
        ? [...new Set(word.reviewDates.filter(Boolean).map(String))].sort()
        : [],
      createdAt: Number.isFinite(word?.createdAt) ? word.createdAt : Date.now()
    };
  }

  function normalizeWords(words) {
    return Array.isArray(words)
      ? words.map(normalizeWord).filter((word) => word.english && word.japanese)
      : [];
  }

  function openDatabase() {
    if (database) return Promise.resolve(database);
    if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB非対応"));

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDBを開けない"));
      request.onblocked = () => reject(new Error("IndexedDB更新がブロックされた"));
    });
  }

  async function readStateRecord() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("保存データを読み込めない"));
    });
  }

  async function writeStateRecord(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("保存に失敗した"));
      tx.onabort = () => reject(tx.error || new Error("保存処理が中断された"));
    });
  }

  function createRecordSnapshot() {
    return {
      key: RECORD_KEY,
      version: APP_DATA_VERSION,
      words: JSON.parse(JSON.stringify(state.words)),
      meta: JSON.parse(JSON.stringify(state.meta))
    };
  }

  async function migrateLegacyLocalStorage() {
    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const words = normalizeWords(parsed?.words);
        if (!words.length && Array.isArray(parsed?.words) && parsed.words.length) continue;
        state.words = words;
        state.meta = {
          ...createDefaultMeta(),
          migratedFromLocalStorage: true,
          changesSinceBackup: words.length ? 1 : 0
        };
        await writeStateRecord(createRecordSnapshot());
        return true;
      } catch (error) {
        console.warn("旧データ移行をスキップ:", error);
      }
    }
    return false;
  }

  async function loadData() {
    try {
      const record = await readStateRecord();
      if (record) {
        state.words = normalizeWords(record.words);
        state.meta = normalizeMeta(record.meta);
        return;
      }

      const migrated = await migrateLegacyLocalStorage();
      if (!migrated) {
        state.words = [];
        state.meta = createDefaultMeta();
        await writeStateRecord(createRecordSnapshot());
      }
    } catch (error) {
      console.error("データの読み込みに失敗:", error);
      state.words = [];
      state.meta = createDefaultMeta();
      showStorageFailure("IndexedDBを利用できない。通常モードのブラウザで開く必要がある。");
    }
  }

  function saveData({ changeAmount = 1 } = {}) {
    if (changeAmount > 0) {
      state.meta.changesSinceBackup += changeAmount;
    }
    state.meta.lastSavedAt = new Date().toISOString();

    refreshAll();
    const snapshot = createRecordSnapshot();
    saveQueue = saveQueue
      .then(() => writeStateRecord(snapshot))
      .catch((error) => {
        console.error("データ保存に失敗:", error);
        showStorageFailure("端末内への保存に失敗した。JSONバックアップを書き出す必要がある。");
      });
    return saveQueue;
  }

  function showStorageFailure(message) {
    const target = $("#storageWarning");
    if (target) {
      target.hidden = false;
      const detail = target.querySelector(".muted");
      if (detail) detail.textContent = message;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value)
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeLoose(value) {
    return normalize(value)
      .replace(/[。、，,.!！?？・]/g, "")
      .replace(/\s+/g, "");
  }

  function splitAnswers(value) {
    return String(value)
      .split(/[、,，\/／;；|｜\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function katakanaToHiragana(value) {
    return [...value].map((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x30a1 && code <= 0x30f6
        ? String.fromCharCode(code - 0x60)
        : character;
    }).join("");
  }

  function normalizeJapanese(value) {
    return katakanaToHiragana(String(value).normalize("NFKC").toLowerCase())
      .replace(/[（(［\[【].*?[）)］\]】]/g, "")
      .replace(/[「」『』〈〉《》“”"'`]/g, "")
      .replace(/[。、，,.!！?？・:：;；…〜~～\s]/g, "")
      .replace(/^[-ー]+|[-ー]+$/g, "");
  }

  function japaneseForms(value) {
    const base = normalizeJapanese(value);
    const forms = new Set([base]);
    if (!base) return forms;

    forms.add(base.replace(/^[をにがはへでと]+/, ""));
    forms.add(base.replace(/をする$/, "する"));

    const removableSuffixes = [
      "する", "します", "しました", "した", "して",
      "される", "された", "させる", "である", "です", "だ",
      "こと", "もの"
    ];
    for (const current of [...forms]) {
      for (const suffix of removableSuffixes) {
        if (current.endsWith(suffix) && [...current].length > [...suffix].length + 1) {
          forms.add(current.slice(0, -suffix.length));
        }
      }
    }
    return new Set([...forms].filter(Boolean));
  }

  function levenshteinDistance(left, right) {
    const a = [...left];
    const b = [...right];
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[b.length];
  }

  function isFlexibleJapaneseMatch(input, answer) {
    const inputForms = japaneseForms(input);
    const answerForms = japaneseForms(answer);

    for (const inputForm of inputForms) {
      for (const answerForm of answerForms) {
        if (inputForm === answerForm) return true;

        const inputLength = [...inputForm].length;
        const answerLength = [...answerForm].length;
        const shorterLength = Math.min(inputLength, answerLength);
        const longerLength = Math.max(inputLength, answerLength);
        if (shorterLength >= 3 && shorterLength / longerLength >= 0.6 &&
            (inputForm.includes(answerForm) || answerForm.includes(inputForm))) {
          return true;
        }

        const allowedDistance = longerLength >= 8 ? 2 : longerLength >= 4 ? 1 : 0;
        if (allowedDistance && levenshteinDistance(inputForm, answerForm) <= allowedDistance) {
          return true;
        }
      }
    }
    return false;
  }

  function isCorrectAnswer(input, expected, strict, direction = "en-ja") {
    const answers = splitAnswers(expected);
    if (!answers.length) answers.push(expected);

    if (strict) {
      const normalizedInput = normalize(input);
      return answers.some((answer) => normalizedInput === normalize(answer));
    }

    if (direction === "en-ja") {
      return answers.some((answer) => isFlexibleJapaneseMatch(input, answer));
    }

    const normalizedInput = normalizeLoose(input);
    return answers.some((answer) => normalizedInput === normalizeLoose(answer));
  }

  const COMMON_MEANINGS = Object.freeze({
    apple: ["りんご"], book: ["本"], water: ["水"], school: ["学校"], teacher: ["先生", "教師"],
    student: ["生徒", "学生"], friend: ["友達", "友人"], family: ["家族"], house: ["家"], room: ["部屋"],
    door: ["ドア", "扉"], window: ["窓"], table: ["机", "テーブル"], chair: ["椅子"], computer: ["コンピューター", "パソコン"],
    phone: ["電話"], car: ["車", "自動車"], train: ["電車", "列車"], station: ["駅"], road: ["道路", "道"],
    city: ["都市", "市"], country: ["国", "田舎"], world: ["世界"], time: ["時間", "時"], day: ["日", "一日"],
    night: ["夜"], morning: ["朝"], week: ["週"], month: ["月"], year: ["年"],
    food: ["食べ物", "食品"], bread: ["パン"], rice: ["米", "ご飯"], meat: ["肉"], fish: ["魚"],
    fruit: ["果物"], vegetable: ["野菜"], coffee: ["コーヒー"], tea: ["お茶", "紅茶"], milk: ["牛乳"],
    eat: ["食べる"], drink: ["飲む"], sleep: ["眠る", "寝る"], wake: ["目を覚ます", "起きる"], walk: ["歩く"],
    run: ["走る", "運営する"], sit: ["座る"], stand: ["立つ"], speak: ["話す"], listen: ["聞く", "耳を傾ける"],
    read: ["読む"], write: ["書く"], study: ["勉強する", "研究する"], teach: ["教える"], learn: ["学ぶ", "習う"],
    think: ["考える", "思う"], know: ["知っている", "分かる"], understand: ["理解する"], remember: ["覚えている", "思い出す"], forget: ["忘れる"],
    see: ["見る", "会う"], watch: ["観る", "見守る"], look: ["見る"], hear: ["聞こえる", "聞く"], feel: ["感じる"],
    make: ["作る"], use: ["使う"], buy: ["買う"], sell: ["売る"], give: ["与える", "あげる"],
    take: ["取る", "持っていく"], bring: ["持ってくる"], send: ["送る"], receive: ["受け取る"], open: ["開ける", "開く"],
    close: ["閉める", "閉じる"], start: ["始める", "始まる"], finish: ["終える", "終わる"], help: ["助ける", "手伝う"], need: ["必要とする", "必要である"],
    want: ["欲しい", "望む"], like: ["好む", "好きである"], love: ["愛する", "大好きである"], live: ["住む", "生きる"], work: ["働く", "機能する"],
    play: ["遊ぶ", "演奏する"], happy: ["幸せな", "うれしい"], sad: ["悲しい"], good: ["良い"], bad: ["悪い"],
    big: ["大きい"], small: ["小さい"], new: ["新しい"], old: ["古い", "年を取った"], young: ["若い"],
    easy: ["簡単な", "容易な"], difficult: ["難しい"], important: ["重要な", "大切な"], beautiful: ["美しい", "きれいな"], interesting: ["興味深い", "面白い"],
    dog: ["犬"], cat: ["猫"], bird: ["鳥"], animal: ["動物"], person: ["人"], people: ["人々"],
    child: ["子ども"], man: ["男性", "男"], woman: ["女性", "女"], name: ["名前"], language: ["言語"],
    english: ["英語"], japanese: ["日本語"], music: ["音楽"], movie: ["映画"], game: ["ゲーム", "試合"],
    picture: ["絵", "写真"], image: ["画像", "印象"], question: ["質問", "問題"], answer: ["答え", "回答"], problem: ["問題"],
    idea: ["考え", "アイデア"], reason: ["理由"], result: ["結果"], example: ["例"], information: ["情報"],
    change: ["変える", "変化"], move: ["動く", "引っ越す"], stop: ["止める", "止まる"], wait: ["待つ"], try: ["試す", "努力する"],
    ask: ["尋ねる", "頼む"], tell: ["伝える", "教える"], say: ["言う"], call: ["呼ぶ", "電話する"], meet: ["会う"],
    find: ["見つける"], lose: ["失う", "負ける"], win: ["勝つ"], choose: ["選ぶ"], decide: ["決める"],
    create: ["作り出す", "作成する"], build: ["建てる", "構築する"], break: ["壊す", "壊れる"], cut: ["切る"], put: ["置く"],
    keep: ["保つ", "持ち続ける"], leave: ["去る", "残す"], return: ["戻る", "返す"], arrive: ["到着する"], travel: ["旅行する"],
    begin: ["始める"], end: ["終わる", "終える"], become: ["なる"], happen: ["起こる"], show: ["見せる", "示す"],
    explain: ["説明する"], improve: ["改善する"], increase: ["増える", "増やす"], decrease: ["減る", "減らす"], include: ["含む"],
    possible: ["可能な"], impossible: ["不可能な"], strong: ["強い"], weak: ["弱い"], fast: ["速い"],
    slow: ["遅い"], high: ["高い"], low: ["低い"], long: ["長い"], short: ["短い"],
    hot: ["暑い", "熱い"], cold: ["寒い", "冷たい"], warm: ["暖かい"], cool: ["涼しい", "かっこいい"], clean: ["きれいな", "清潔な"],
    dirty: ["汚い"], right: ["正しい", "右"], wrong: ["間違った"], true: ["本当の", "真実の"], false: ["誤った", "偽の"],
    same: ["同じ"], different: ["異なる"], many: ["多くの"], few: ["少数の"], all: ["すべての"],
    some: ["いくつかの"], first: ["最初の"], last: ["最後の"], next: ["次の"], early: ["早い"],
    late: ["遅い"], always: ["いつも"], never: ["決してない"], often: ["しばしば"], sometimes: ["時々"],
    now: ["今"], today: ["今日"], tomorrow: ["明日"], yesterday: ["昨日"], here: ["ここ"],
    there: ["そこ", "あそこ"], why: ["なぜ"], how: ["どのように"], what: ["何"], who: ["誰"],
    where: ["どこ"], when: ["いつ"], because: ["なぜなら", "なので"], before: ["前に"], after: ["後に"],
    inside: ["内側", "中に"], outside: ["外側", "外に"], above: ["上に"], below: ["下に"], between: ["間に"],
    achieve: ["達成する"], accomplish: ["達成する", "成し遂げる"], develop: ["発展させる", "開発する"], protect: ["守る"], support: ["支える", "支持する"]
  });

  function normalizeEnglishLookup(value) {
    return normalize(value).replace(/^to\s+/, "").replace(/[^a-z0-9' -]/g, "").trim();
  }

  const SPELL_WORDS = Array.isArray(window.WORD_STUDY_SPELL_WORDS)
    ? window.WORD_STUDY_SPELL_WORDS
    : Object.keys(COMMON_MEANINGS);
  const SPELL_WORD_SET = new Set([
    ...SPELL_WORDS,
    ...Object.keys(COMMON_MEANINGS),
    "chatgpt", "github", "pwa", "api", "csv", "json"
  ].map((word) => normalizeEnglishLookup(word)).filter(Boolean));
  const SPELL_WORDS_BY_LENGTH = new Map();
  for (const word of SPELL_WORD_SET) {
    const length = word.length;
    if (!SPELL_WORDS_BY_LENGTH.has(length)) SPELL_WORDS_BY_LENGTH.set(length, []);
    SPELL_WORDS_BY_LENGTH.get(length).push(word);
  }
  const COMMON_SPELL_WORDS = new Set(Object.keys(COMMON_MEANINGS));

  function englishTokens(value) {
    return normalizeEnglishLookup(value)
      .split(/[\s-]+/)
      .map((token) => token.replace(/^'+|'+$/g, ""))
      .filter(Boolean);
  }

  function isAcceptedInflection(token) {
    const checks = [];
    if (token.endsWith("ies") && token.length > 4) checks.push(`${token.slice(0, -3)}y`);
    if (token.endsWith("es") && token.length > 3) checks.push(token.slice(0, -2), token.slice(0, -1));
    if (token.endsWith("s") && token.length > 3) checks.push(token.slice(0, -1));
    if (token.endsWith("ing") && token.length > 5) {
      const base = token.slice(0, -3);
      checks.push(base, `${base}e`);
      if (base.length > 2 && base.at(-1) === base.at(-2)) checks.push(base.slice(0, -1));
    }
    if (token.endsWith("ed") && token.length > 4) {
      const base = token.slice(0, -2);
      checks.push(base, `${base}e`);
      if (base.endsWith("i")) checks.push(`${base.slice(0, -1)}y`);
      if (base.length > 2 && base.at(-1) === base.at(-2)) checks.push(base.slice(0, -1));
    }
    if (token.endsWith("ly") && token.length > 4) checks.push(token.slice(0, -2));
    if (token.endsWith("er") && token.length > 4) checks.push(token.slice(0, -2), `${token.slice(0, -1)}e`);
    if (token.endsWith("est") && token.length > 5) checks.push(token.slice(0, -3), `${token.slice(0, -2)}e`);
    return checks.some((candidate) => SPELL_WORD_SET.has(candidate));
  }

  function isKnownSpelling(token) {
    if (!token || token.length <= 2 || /\d/.test(token)) return true;
    return SPELL_WORD_SET.has(token) || isAcceptedInflection(token);
  }

  function spellSuggestionsForToken(token, limit = 3) {
    const normalized = normalizeEnglishLookup(token);
    if (!normalized || normalized.length <= 2 || isKnownSpelling(normalized)) return [];
    const maximumDistance = normalized.length >= 8 ? 2 : 1;
    const candidates = [];
    for (let length = Math.max(2, normalized.length - maximumDistance); length <= normalized.length + maximumDistance; length++) {
      const bucket = SPELL_WORDS_BY_LENGTH.get(length) || [];
      for (const candidate of bucket) {
        if (candidate[0] !== normalized[0]) continue;
        const distance = levenshteinDistance(normalized, candidate);
        if (distance <= maximumDistance) {
          candidates.push({
            word: candidate,
            distance,
            priority: COMMON_SPELL_WORDS.has(candidate) ? 0 : 1
          });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority || a.word.localeCompare(b.word, "en"));
    return [...new Set(candidates.map((item) => item.word))].slice(0, limit);
  }

  function replaceTokenInPhrase(phrase, targetIndex, replacement) {
    let index = -1;
    return String(phrase).replace(/[A-Za-z][A-Za-z'-]*/g, (token) => {
      index += 1;
      return index === targetIndex ? replacement : token;
    });
  }

  function checkEnglishSpelling(value) {
    const tokens = englishTokens(value);
    if (!tokens.length) return { status: "empty", issues: [], suggestions: [] };
    const issues = [];
    tokens.forEach((token, index) => {
      if (isKnownSpelling(token)) return;
      const candidates = spellSuggestionsForToken(token);
      if (candidates.length) issues.push({ token, index, candidates });
    });
    if (!issues.length) {
      const unknownTokens = tokens.filter((token) => !isKnownSpelling(token));
      return unknownTokens.length
        ? { status: "unknown", issues: [], suggestions: [] }
        : { status: "ok", issues: [], suggestions: [] };
    }
    const phraseSuggestions = issues[0].candidates.map((candidate) => replaceTokenInPhrase(value, issues[0].index, candidate));
    return { status: "warning", issues, suggestions: phraseSuggestions };
  }

  function duplicateStatus(english, japanese) {
    const normalizedEnglish = normalize(english);
    const normalizedJapanese = normalizeJapanese(japanese);
    const sameEnglish = state.words.filter((word) => normalize(word.english) === normalizedEnglish);
    const exact = sameEnglish.find((word) => normalizeJapanese(word.japanese) === normalizedJapanese);
    return { exact, sameEnglish };
  }

  function speakEnglish(text) {
    const target = String(text || "").trim();
    if (!target) return;
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      alert("このブラウザは音声読み上げに対応していない。");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(target);
    utterance.lang = "en-US";
    utterance.rate = 0.82;
    utterance.pitch = 1;
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((item) => /^en-US/i.test(item.lang))
      || voices.find((item) => /^en/i.test(item.lang));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDaysToLocalDate(baseDateString, days) {
    const [year, month, day] = baseDateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + days);
    return localDateString(date);
  }

  function scheduleReview(word, baseDate = localDateString()) {
    const offsets = [1, 4, 7, 14, 30];
    const dates = offsets.map((days) => addDaysToLocalDate(baseDate, days));
    word.reviewDates = [...new Set([...(word.reviewDates || []), ...dates])].sort();
    word.mistakeHistory = [...(word.mistakeHistory || []), baseDate];
  }

  function dueDates(word, today = localDateString()) {
    return (word.reviewDates || []).filter((date) => date <= today);
  }

  function isUnanswered(word) {
    return word.correct + word.mistakes === 0;
  }

  function isDueToday(word) {
    return isUnanswered(word) || dueDates(word).length > 0;
  }

  function completeDueReviews(word, today = localDateString()) {
    word.reviewDates = (word.reviewDates || []).filter((date) => date > today);
  }

  function addWord(english, japanese) {
    const en = english.trim();
    const ja = japanese.trim();
    if (!en || !ja) return { ok: false, message: "英語と日本語訳の両方を入力する必要がある。" };

    const duplicate = state.words.find(
      (word) => normalize(word.english) === normalize(en) && normalize(word.japanese) === normalize(ja)
    );
    if (duplicate) return { ok: false, message: "同じ英語・日本語訳の組み合わせが既に登録されている。" };

    state.words.unshift({
      id: generateId(),
      english: en,
      japanese: ja,
      correct: 0,
      mistakes: 0,
      mistakeHistory: [],
      reviewDates: [],
      createdAt: Date.now()
    });

    saveData();
    return { ok: true, message: `「${en}」を追加した。` };
  }

  function clearRegistrationWarning() {
    state.pendingRegistration = null;
    const panel = $("#registrationWarning");
    if (panel) panel.hidden = true;
  }

  function finishSingleAdd(result, focusEnglish = true) {
    showNotice($("#addNotice"), result.message, result.ok ? "success" : "error");
    if (!result.ok) return;
    $("#englishInput").value = "";
    $("#japaneseInput").value = "";
    if ($("#spellCheckStatus")) $("#spellCheckStatus").innerHTML = "";
    clearRegistrationWarning();
    if (focusEnglish) $("#englishInput").focus();
  }

  function renderSpellStatus() {
    const target = $("#spellCheckStatus");
    if (!target) return;
    const value = $("#englishInput")?.value || "";
    const result = checkEnglishSpelling(value);
    target.className = "spell-status";
    if (result.status === "empty") {
      target.innerHTML = "";
      return;
    }
    if (result.status === "ok") {
      target.classList.add("ok");
      target.textContent = "スペルを確認済み";
      return;
    }
    if (result.status === "unknown") {
      target.classList.add("warning");
      target.textContent = "辞書にない語。固有名詞・専門用語ならそのまま登録できる。";
      return;
    }
    target.classList.add("warning");
    target.innerHTML = `スペル候補を確認: <div class="spell-suggestions">${result.suggestions.map((suggestion) => `<button class="spell-chip" type="button" data-spell-suggestion="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>`).join("")}</div>`;
  }

  let spellStatusTimer = null;
  function scheduleSpellStatusCheck() {
    if (spellStatusTimer) clearTimeout(spellStatusTimer);
    spellStatusTimer = setTimeout(renderSpellStatus, 350);
  }

  function showRegistrationWarning(type, english, japanese, details = {}, focusEnglish = true) {
    state.pendingRegistration = { type, english: english.trim(), japanese: japanese.trim(), details, focusEnglish };
    const title = $("#registrationWarningTitle");
    const body = $("#registrationWarningBody");
    const apply = $("#applySpellSuggestionBtn");
    const confirmButton = $("#confirmRegistrationBtn");
    apply.hidden = true;
    confirmButton.hidden = true;

    if (type === "exact-duplicate") {
      title.textContent = "同じ単語が登録済み";
      body.innerHTML = `<p><strong>${escapeHtml(english)}</strong> ＝ ${escapeHtml(japanese)}</p><p class="muted">完全に同じ組み合わせは重複登録できない。</p>`;
    } else if (type === "spelling") {
      title.textContent = "スペルを確認";
      const suggestions = details.suggestions || [];
      body.innerHTML = `<p>「<strong>${escapeHtml(english)}</strong>」は入力ミスの可能性がある。</p><div class="spell-suggestions">${suggestions.map((suggestion) => `<button class="spell-chip" type="button" data-spell-suggestion="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>`).join("")}</div>`;
      if (suggestions.length) {
        apply.hidden = false;
        apply.textContent = `「${suggestions[0]}」を使う`;
      }
      confirmButton.hidden = false;
      confirmButton.textContent = "この綴りで登録";
    } else if (type === "same-english") {
      title.textContent = "同じ英単語が登録済み";
      const meanings = details.existing.map((word) => word.japanese).join("、");
      body.innerHTML = `<p><strong>${escapeHtml(english)}</strong> はすでに登録されている。</p><div class="duplicate-detail"><span class="muted">登録済みの意味</span><br>${escapeHtml(meanings)}</div><p class="muted" style="margin-top:9px">別の意味として追加する場合だけ続行する。</p>`;
      confirmButton.hidden = false;
      confirmButton.textContent = "この意味も追加";
    }
    $("#registrationWarning").hidden = false;
    $("#registrationWarning").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function attemptSingleAdd(focusEnglish = true, options = {}) {
    const english = $("#englishInput").value.trim();
    const japanese = $("#japaneseInput").value.trim();
    clearRegistrationWarning();

    if (!english || !japanese) {
      finishSingleAdd({ ok: false, message: "英語と日本語訳の両方を入力する必要がある。" }, focusEnglish);
      return;
    }

    const duplicates = duplicateStatus(english, japanese);
    if (duplicates.exact) {
      showNotice($("#addNotice"), "完全に同じ単語がすでに登録されている。", "error");
      showRegistrationWarning("exact-duplicate", english, japanese, {}, focusEnglish);
      return;
    }

    if (!options.bypassSpelling) {
      const spelling = checkEnglishSpelling(english);
      if (spelling.status === "warning") {
        showNotice($("#addNotice"), "登録前にスペルを確認する必要がある。", "error");
        showRegistrationWarning("spelling", english, japanese, spelling, focusEnglish);
        return;
      }
    }

    if (!options.bypassSameEnglish && duplicates.sameEnglish.length) {
      showNotice($("#addNotice"), "同じ英単語がすでに登録されている。", "error");
      showRegistrationWarning("same-english", english, japanese, { existing: duplicates.sameEnglish }, focusEnglish);
      return;
    }

    finishSingleAdd(addWord(english, japanese), focusEnglish);
  }

  function clearBulkSpellWarning() {
    state.pendingBulkSpellWarnings = [];
    const panel = $("#bulkSpellWarning");
    if (panel) panel.hidden = true;
  }

  function showBulkSpellWarnings(warnings) {
    state.pendingBulkSpellWarnings = warnings;
    $("#bulkSpellWarningList").innerHTML = warnings.map((item) => {
      const suggestions = item.spelling.suggestions || [];
      return `<div class="warning-item"><strong>${escapeHtml(item.english)}</strong> ＝ ${escapeHtml(item.japanese)}<br><span class="muted">候補:</span> ${escapeHtml(suggestions.join("、") || "候補なし")}</div>`;
    }).join("");
    $("#useBulkSpellSuggestionsBtn").hidden = warnings.some((item) => !item.spelling.suggestions.length);
    $("#bulkSpellWarning").hidden = false;
  }

  function registerPendingBulkSpell(useSuggested) {
    const warnings = [...state.pendingBulkSpellWarnings];
    if (!warnings.length) return;
    let added = 0;
    let skipped = 0;
    const duplicateItems = [];
    for (const item of warnings) {
      const english = useSuggested && item.spelling.suggestions.length
        ? item.spelling.suggestions[0]
        : item.english;
      const duplicates = duplicateStatus(english, item.japanese);
      if (duplicates.exact) {
        skipped += 1;
        duplicateItems.push({ english, japanese: item.japanese, type: "exact" });
        continue;
      }
      if (duplicates.sameEnglish.length) {
        duplicateItems.push({ english, japanese: item.japanese, type: "same", existing: duplicates.sameEnglish.map((word) => word.japanese) });
      }
      const result = addWord(english, item.japanese);
      result.ok ? added++ : skipped++;
    }
    clearBulkSpellWarning();
    if (duplicateItems.length) renderBulkDuplicateReport(duplicateItems);
    $("#bulkInput").value = "";
    showNotice($("#bulkNotice"), `${added}語を追加、${skipped}行をスキップした。`, added ? "success" : "error");
  }

  function renderBulkDuplicateReport(items) {
    const panel = $("#bulkDuplicateReport");
    const list = $("#bulkDuplicateReportList");
    if (!panel || !list) return;
    if (!items.length) {
      panel.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.innerHTML = items.map((item) => {
      const detail = item.type === "exact"
        ? "完全に同じためスキップ"
        : `同じ英単語を別の意味として追加（登録済み: ${item.existing.join("、")}）`;
      return `<div class="warning-item"><strong>${escapeHtml(item.english)}</strong> ＝ ${escapeHtml(item.japanese)}<br><span class="muted">${escapeHtml(detail)}</span></div>`;
    }).join("");
    panel.hidden = false;
  }

  function showNotice(target, message, type = "") {
    if (!target) return;
    target.innerHTML = `<div class="notice ${type}">${escapeHtml(message)}</div>`;
  }

  function showRegistrationChooser() {
    const chooser = $("#registrationChooser");
    const single = $("#singleRegistrationView");
    const bulk = $("#bulkRegistrationView");
    if (chooser) chooser.hidden = false;
    if (single) single.hidden = true;
    if (bulk) bulk.hidden = true;
  }

  function showRegistrationMode(mode) {
    const chooser = $("#registrationChooser");
    const single = $("#singleRegistrationView");
    const bulk = $("#bulkRegistrationView");
    if (chooser) chooser.hidden = true;
    if (single) single.hidden = mode !== "single";
    if (bulk) bulk.hidden = mode !== "bulk";
    requestAnimationFrame(() => {
      if (mode === "single") $("#englishInput")?.focus();
      if (mode === "bulk") $("#bulkInput")?.focus();
    });
  }

  function openSettings() {
    renderStorageStatus();
    renderNotificationSettings();
    const dialog = $("#settingsDialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeSettings() {
    const dialog = $("#settingsDialog");
    if (dialog?.open) dialog.close();
  }

  function switchTab(tabName, options = {}) {
    const todayQuiz = tabName === "quiz" && options.quizMode === "today";
    const activeTabName = todayQuiz ? "today" : tabName;
    if (tabName !== "quiz") document.body.classList.remove("quiz-playing");
    document.body.dataset.accent = activeTabName === "today" ? "today" : "quiz";

    $$(".tab").forEach((tab) => {
      const active = tab.dataset.tab === activeTabName;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-current", active ? "page" : "false");
    });
    $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${tabName}`));

    if (tabName === "quiz") {
      showQuizSetup(todayQuiz ? "today" : "standard");
      if (options.autoStart === true) startQuizFromSetup();
    }
    if (tabName === "today") renderToday();
    if (tabName === "add") showRegistrationChooser();
    if (tabName === "list") renderWordList();
    if (tabName === "analysis") requestAnimationFrame(renderAnalysis);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateSummary() {
    const totalAnswers = state.words.reduce((sum, word) => sum + word.correct + word.mistakes, 0);
    const totalCorrect = state.words.reduce((sum, word) => sum + word.correct, 0);
    const todayCount = state.words.filter(isDueToday).length;
    $("#statWords").textContent = state.words.length;
    $("#statAnswers").textContent = totalAnswers;
    $("#statCorrect").textContent = totalCorrect;
    $("#statRate").textContent = totalAnswers ? `${Math.round((totalCorrect / totalAnswers) * 100)}%` : "—";
    $("#statToday").textContent = todayCount;
    if ($("#todayReminderCount")) $("#todayReminderCount").textContent = String(todayCount);
  }

  function getAccuracy(word) {
    const total = word.correct + word.mistakes;
    return total ? Math.round((word.correct / total) * 100) : null;
  }

  function tableMarkup(words, mode = "list") {
    if (!words.length) {
      return `<div class="empty">${mode === "mistakes" ? "間違い記録はまだない。" : "条件に一致する単語はない。"}</div>`;
    }

    const rows = words.map((word) => {
      const accuracy = getAccuracy(word);
      const actions = mode === "mistakes"
        ? `<button class="btn small ghost" type="button" data-action="reset" data-id="${escapeHtml(word.id)}">回数をリセット</button>`
        : `
          <button class="btn small ghost" type="button" data-action="edit" data-id="${escapeHtml(word.id)}">編集</button>
          <button class="btn small danger" type="button" data-action="delete" data-id="${escapeHtml(word.id)}">削除</button>
        `;

      return `
        <tr>
          <td class="word-main-cell" data-label="英語"><div class="english-with-audio"><strong>${escapeHtml(word.english)}</strong><button class="speak-button" type="button" data-speak="${escapeHtml(word.english)}" aria-label="${escapeHtml(word.english)}の発音を聞く">🔊</button></div></td>
          <td data-label="日本語訳">${escapeHtml(word.japanese)}</td>
          <td class="number" data-label="正解">${word.correct}</td>
          <td class="number mistake-count" data-label="誤答">${word.mistakes}</td>
          <td class="number rate" data-label="正答率">${accuracy === null ? "—" : `${accuracy}%`}</td>
          <td class="word-actions-cell" data-label="操作"><div class="word-actions">${actions}</div></td>
        </tr>
      `;
    }).join("");

    return `
      <div class="table-wrap">
        <table class="${mode === "list" ? "word-management-table" : ""}">
          <thead>
            <tr>
              <th>英語</th>
              <th>日本語訳</th>
              <th class="number">正解</th>
              <th class="number">誤答</th>
              <th class="number">正答率</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function sortedWords(words, sort) {
    const copy = [...words];
    switch (sort) {
      case "oldest": return copy.sort((a, b) => a.createdAt - b.createdAt);
      case "english": return copy.sort((a, b) => a.english.localeCompare(b.english, "en"));
      case "mistakes-desc": return copy.sort((a, b) => b.mistakes - a.mistakes || b.createdAt - a.createdAt);
      case "accuracy-asc": return copy.sort((a, b) => {
        const aTotal = a.correct + a.mistakes;
        const bTotal = b.correct + b.mistakes;
        const aRate = aTotal ? a.correct / aTotal : 1;
        const bRate = bTotal ? b.correct / bTotal : 1;
        return aRate - bRate || b.mistakes - a.mistakes || a.english.localeCompare(b.english, "en");
      });
      case "unanswered-first": return copy.sort((a, b) => {
        const aUnanswered = a.correct + a.mistakes === 0;
        const bUnanswered = b.correct + b.mistakes === 0;
        return Number(bUnanswered) - Number(aUnanswered) || b.createdAt - a.createdAt;
      });
      case "newest":
      default: return copy.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  function renderWordList() {
    const query = normalize($("#searchInput").value);
    const filtered = state.words.filter((word) =>
      !query || normalize(word.english).includes(query) || normalize(word.japanese).includes(query)
    );
    $("#wordTable").innerHTML = tableMarkup(sortedWords(filtered, $("#listSort").value));
  }

  function renderMistakes() {
    const words = state.words
      .filter((word) => word.mistakes > 0)
      .sort((a, b) => b.mistakes - a.mistakes || a.english.localeCompare(b.english, "en"));
    $("#mistakeTable").innerHTML = tableMarkup(words, "mistakes");
  }

  function renderToday() {
    const today = localDateString();
    const words = state.words
      .filter(isDueToday)
      .sort((a, b) => {
        const aUnanswered = isUnanswered(a);
        const bUnanswered = isUnanswered(b);
        if (aUnanswered !== bUnanswered) return aUnanswered ? -1 : 1;
        if (aUnanswered && bUnanswered) return a.createdAt - b.createdAt;
        const aDate = dueDates(a, today).sort()[0] || "9999-12-31";
        const bDate = dueDates(b, today).sort()[0] || "9999-12-31";
        return aDate.localeCompare(bDate) || b.mistakes - a.mistakes;
      });

    const unansweredCount = words.filter(isUnanswered).length;
    const reviewCount = words.length - unansweredCount;
    $("#todayCount").textContent = words.length;
    $("#todayMessage").textContent = words.length
      ? `未回答${unansweredCount}語・復習期限到達${reviewCount}語、合計${words.length}語が対象だ。`
      : "今日の学習対象はない。";
    $("#startTodayBtn").disabled = words.length === 0;

    if (!words.length) {
      $("#todayTable").innerHTML = '<div class="empty">未回答の単語と、復習期限に到達した単語はここに表示される。</div>';
      return;
    }

    const rows = words.map((word) => {
      const unanswered = isUnanswered(word);
      const oldestDue = dueDates(word, today).sort()[0];
      const status = unanswered ? "未回答" : `${oldestDue}から期限`;
      return `
        <tr>
          <td><div class="english-with-audio"><strong>${escapeHtml(word.english)}</strong><button class="speak-button" type="button" data-speak="${escapeHtml(word.english)}" aria-label="${escapeHtml(word.english)}の発音を聞く">🔊</button></div></td>
          <td>${escapeHtml(word.japanese)}</td>
          <td><span class="due-badge">${escapeHtml(status)}</span></td>
          <td class="number mistake-count">${word.mistakes}</td>
        </tr>`;
    }).join("");

    $("#todayTable").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>英語</th><th>日本語訳</th><th>区分</th><th class="number">誤答</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function showQuizSetup(mode = "standard") {
    const todayMode = mode === "today";
    state.quizSetupMode = todayMode ? "today" : "standard";
    state.quizRangeOverride = todayMode ? "today" : null;
    resetQuizSession();

    document.body.classList.remove("quiz-playing");
    $("#quizSetupView").hidden = false;
    $("#quizPlayView").hidden = true;
    $("#quizSetupTitle").textContent = todayMode ? "今日の単語" : "問題";
    $("#quizSetupLead").textContent = todayMode
      ? "出題方向を選択する。"
      : "出題方向・出題範囲・出題順を選択する。";
    $("#quizRangeGroup").hidden = todayMode;
    $("#quizOrderGroup").hidden = todayMode;
    $("#quizToolbar").classList.toggle("today-mode", todayMode);
    if (todayMode) $("#quizOrder").value = "random";

    updateQuizCountControl();
    updateQuizSetupAvailability();
  }

  function showQuizPlayView() {
    document.body.classList.add("quiz-playing");
    $("#quizSetupView").hidden = true;
    $("#quizPlayView").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateQuizSetupAvailability() {
    const count = getFilteredQuizWords().length;
    const button = $("#startQuizBtn");
    const notice = $("#quizSetupNotice");
    if (!button || !notice) return;

    button.disabled = count === 0;
    if (count > 0) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }

    notice.hidden = false;
    notice.className = "quiz-setup-notice notice error";
    notice.textContent = state.words.length
      ? "選択した出題範囲に該当する単語がない。"
      : "単語を登録すると問題を開始できる。";
  }

  function startQuizFromSetup() {
    updateQuizCountControl();
    if (!getFilteredQuizWords().length) {
      updateQuizSetupAvailability();
      return;
    }
    resetQuizSession();
    showQuizPlayView();
    startQuizSession();
  }

  function currentQuizRange() {
    return state.quizRangeOverride || $("#quizRange").value;
  }

  function getFilteredQuizWords(range = currentQuizRange()) {
    let words = [...state.words];
    if (range === "mistakes") words = words.filter((word) => word.mistakes > 0);
    if (range === "today") words = words.filter(isDueToday);
    if (range === "unanswered") words = words.filter(isUnanswered);
    return words;
  }

  function usesQuestionLimit() {
    return false;
  }

  function updateQuizCountControl() {
    const range = currentQuizRange();
    const group = $("#quizCountGroup");
    const input = $("#quizCount");
    const limited = usesQuestionLimit(range);

    group.hidden = !limited;
    if (!limited) return;

    const available = getFilteredQuizWords(range).length;
    input.disabled = available === 0;
    input.max = String(Math.max(1, available));

    let requested = Number.parseInt(input.value, 10);
    if (!Number.isFinite(requested) || requested < 1) requested = Math.min(10, Math.max(1, available));
    if (available > 0) requested = Math.min(requested, available);
    input.value = String(requested);

  }

  function requestedQuestionCount(available) {
    if (!usesQuestionLimit()) return available;
    const input = $("#quizCount");
    const parsed = Number.parseInt(input.value, 10);
    const fallback = Math.min(10, available);
    const count = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(1, Math.min(count, available));
  }

  function getQuizPool() {
    const range = currentQuizRange();
    let words = getFilteredQuizWords(range);

    const order = $("#quizOrder").value;
    if (order === "mistakes-desc") {
      words.sort((a, b) => b.mistakes - a.mistakes || b.createdAt - a.createdAt);
    } else if (order === "newest") {
      words.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
      }
    }

    if (usesQuestionLimit(range) && words.length) {
      words = words.slice(0, requestedQuestionCount(words.length));
    }
    return words;
  }

  function resetQuizSession() {
    state.currentQuizWordId = null;
    state.filteredQuizIds = [];
    state.quizSessionIds = [];
    state.quizSessionIndex = 0;
    state.quizSessionComplete = false;
    state.answered = false;
    state.manualJudgePending = false;
  }

  function showQuizEmpty(message, action = "add") {
    $("#quizEmpty").hidden = false;
    $("#quizContent").hidden = true;
    $("#quizEmpty .empty").textContent = message;
    const button = $("#quizEmptyAction");
    button.dataset.action = action;
    button.textContent = action === "restart" ? "同じ条件でもう一度" : "単語を登録する";
  }

  function startQuizSession() {
    updateQuizCountControl();
    const pool = getQuizPool();
    state.filteredQuizIds = pool.map((word) => word.id);
    state.quizSessionIds = [...state.filteredQuizIds];
    state.quizSessionIndex = 0;
    state.quizSessionComplete = false;
    state.currentQuizWordId = null;

    if (!pool.length) {
      showQuizEmpty(
        state.words.length
          ? "選択した出題範囲に該当する単語がない。"
          : "単語を登録すると問題を開始できる。",
        "add"
      );
      return;
    }

    $("#quizEmpty").hidden = true;
    $("#quizContent").hidden = false;
    chooseNextQuestion(true);
  }

  function prepareQuiz(forceNew = false) {
    updateQuizCountControl();

    if (forceNew || !state.quizSessionIds.length) {
      startQuizSession();
      return;
    }

    if (state.quizSessionComplete) {
      showQuizEmpty(`${state.quizSessionIds.length}問が終了した。`, "restart");
      return;
    }

    const currentExists = state.words.some((word) => word.id === state.currentQuizWordId);
    if (!currentExists) {
      chooseNextQuestion(false);
      return;
    }

    $("#quizEmpty").hidden = true;
    $("#quizContent").hidden = false;
    renderCurrentQuestion();
  }

  function completeQuizSession() {
    state.currentQuizWordId = null;
    state.quizSessionComplete = true;
    state.answered = false;
    state.manualJudgePending = false;
    showQuizEmpty(`${state.quizSessionIds.length}問が終了した。`, "restart");
  }

  function findNextExistingSessionWord(startIndex) {
    for (let index = startIndex; index < state.quizSessionIds.length; index++) {
      const word = state.words.find((item) => item.id === state.quizSessionIds[index]);
      if (word) return { word, index };
    }
    return null;
  }

  function hasNextSessionWord() {
    return Boolean(findNextExistingSessionWord(state.quizSessionIndex + 1));
  }

  function chooseNextQuestion(first = false) {
    if (!state.quizSessionIds.length) {
      startQuizSession();
      return;
    }

    const startIndex = first ? 0 : state.quizSessionIndex + 1;
    const next = findNextExistingSessionWord(startIndex);
    if (!next) {
      completeQuizSession();
      return;
    }

    state.quizSessionIndex = next.index;
    state.currentQuizWordId = next.word.id;
    const directionSetting = $("#quizDirection").value;
    state.currentDirection = directionSetting === "random"
      ? (Math.random() < 0.5 ? "en-ja" : "ja-en")
      : directionSetting;
    state.answered = false;
    renderCurrentQuestion();
  }

  function renderCurrentQuestion() {
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) {
      chooseNextQuestion(false);
      return;
    }

    const enToJa = state.currentDirection === "en-ja";
    $("#quizProgress").textContent = `${state.quizSessionIndex + 1} / ${state.quizSessionIds.length}`;
    $("#questionLabel").textContent = enToJa ? "日本語訳を入力" : "英語を入力";
    $("#questionText").textContent = enToJa ? word.english : word.japanese;
    $("#speakQuestionBtn").hidden = !enToJa;
    $("#speakQuestionBtn").dataset.speak = enToJa ? word.english : "";
    $("#answerInput").value = "";
    $("#answerInput").disabled = false;
    $("#checkBtn").hidden = false;
    $("#showAnswerBtn").hidden = false;
    $("#quizNextRow").hidden = true;
    $("#nextBtn").textContent = "次の問題へ";
    $("#nextBtn").className = "btn next-small";
    $("#manualJudgeRow").hidden = true;
    $("#markCorrectBtn").disabled = false;
    $("#markWrongBtn").disabled = false;
    $("#feedback").className = "feedback";
    $("#feedback").textContent = "";
    $("#feedback").hidden = true;
    state.answered = false;
    state.manualJudgePending = false;
    setTimeout(() => $("#answerInput").focus(), 0);
  }

  function correctAnswerMarkup(expected, label = "模範解答：", englishText = "") {
    const speakButton = englishText
      ? `<button class="speak-button" type="button" data-speak="${escapeHtml(englishText)}">🔊 発音を聞く</button>`
      : "";
    return `<div class="correct-answer-card"><div class="correct-answer-label">${escapeHtml(label)}</div><div class="correct-answer-text">${escapeHtml(expected)}</div>${speakButton}</div>`;
  }

  function resultStatusMarkup(result, note = "") {
    const label = result === "correct" ? "正解" : "不正解";
    const noteMarkup = note ? `<div class="result-note">${escapeHtml(note)}</div>` : "";
    return `<div class="result-status ${result}">${label}</div>${noteMarkup}`;
  }

  function updateNextActionButton() {
    const hasNext = hasNextSessionWord();
    const button = $("#nextBtn");
    button.textContent = hasNext ? "次の問題へ" : "終了";
    button.className = hasNext
      ? "btn next-small"
      : "btn next-small finish-action";
  }

  function finishAnswer(result, message) {
    state.answered = true;
    state.manualJudgePending = false;
    $("#answerInput").disabled = true;
    $("#checkBtn").hidden = true;
    $("#showAnswerBtn").hidden = true;
    $("#manualJudgeRow").hidden = true;
    $("#quizNextRow").hidden = false;
    updateNextActionButton();
    $("#feedback").hidden = false;
    $("#feedback").className = `feedback ${result}`;
    $("#feedback").innerHTML = message;
    $("#nextBtn").focus();
  }

  function recordCorrectAnswer(word, expected) {
    word.correct += 1;
    recordAnswerHistory("correct");
    if (currentQuizRange() === "today") completeDueReviews(word);
    saveData();
    finishAnswer(
      "correct",
      `${resultStatusMarkup("correct")}${correctAnswerMarkup(expected, "模範解答：", state.currentDirection === "ja-en" ? expected : "")}`
    );
  }

  function recordWrongAnswer(word, expected, note = "") {
    word.mistakes += 1;
    recordAnswerHistory("wrong");
    if (currentQuizRange() === "today") completeDueReviews(word);
    scheduleReview(word);
    saveData();
    finishAnswer(
      "wrong",
      `${resultStatusMarkup("wrong", note)}${correctAnswerMarkup(expected, "模範解答：", state.currentDirection === "ja-en" ? expected : "")}`
    );
  }

  function requestManualJudgement(input, expected) {
    state.manualJudgePending = true;
    $("#answerInput").disabled = true;
    $("#checkBtn").hidden = true;
    $("#showAnswerBtn").hidden = true;
    $("#quizNextRow").hidden = true;
    $("#manualJudgeRow").hidden = false;
    $("#markCorrectBtn").disabled = false;
    $("#markWrongBtn").disabled = false;
    $("#feedback").hidden = false;
    $("#feedback").className = "feedback";
    $("#feedback").innerHTML =
      `<strong>自動では判定できない。</strong><br>` +
      `入力: ${escapeHtml(input)}` +
      correctAnswerMarkup(expected, "登録された答え") +
      `<span class="muted">意味が合っている場合は「正解として扱う」を押す。</span>`;
    $("#markCorrectBtn").focus();
  }

  function resolveManualJudgement(isCorrect) {
    if (!state.manualJudgePending) return;

    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) return;

    state.manualJudgePending = false;
    $("#markCorrectBtn").disabled = true;
    $("#markWrongBtn").disabled = true;

    const expected = state.currentDirection === "en-ja" ? word.japanese : word.english;
    if (isCorrect) {
      recordCorrectAnswer(word, expected);
    } else {
      recordWrongAnswer(word, expected);
    }
  }

  function checkAnswer() {
    if (state.manualJudgePending) return;
    if (state.answered) return chooseNextQuestion();
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) return;

    const input = $("#answerInput").value.trim();
    if (!input) {
      $("#feedback").hidden = false;
      $("#feedback").className = "feedback wrong";
      $("#feedback").textContent = "回答が未入力だ。";
      return;
    }

    const expected = state.currentDirection === "en-ja" ? word.japanese : word.english;
    const strict = $("#strictAnswer").checked;
    const correct = isCorrectAnswer(input, expected, strict, state.currentDirection);
    if (correct) {
      recordCorrectAnswer(word, expected);
    } else if (state.currentDirection === "en-ja" && !strict) {
      requestManualJudgement(input, expected);
    } else {
      recordWrongAnswer(word, expected);
    }
  }

  function revealAnswer() {
    if (state.answered) return;
    const word = state.words.find((item) => item.id === state.currentQuizWordId);
    if (!word) return;
    const expected = state.currentDirection === "en-ja" ? word.japanese : word.english;
    word.mistakes += 1;
    recordAnswerHistory("revealed");
    if (currentQuizRange() === "today") completeDueReviews(word);
    scheduleReview(word);
    saveData();
    finishAnswer("wrong", `${resultStatusMarkup("wrong", "答えを表示したため不正解として記録")}${correctAnswerMarkup(expected, "模範解答：", state.currentDirection === "ja-en" ? expected : "")}`);
  }

  function recordAnswerHistory(result) {
    const history = Array.isArray(state.meta.answerHistory) ? state.meta.answerHistory : [];
    history.push({ date: localDateString(), result });
    state.meta.answerHistory = history.slice(-10000);
  }

  function last30DateKeys() {
    const keys = [];
    const today = new Date();
    for (let offset = 29; offset >= 0; offset--) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      date.setDate(date.getDate() - offset);
      keys.push(localDateString(date));
    }
    return keys;
  }

  function analyticsSeries() {
    const dates = last30DateKeys();
    const added = Object.fromEntries(dates.map((date) => [date, 0]));
    const answered = Object.fromEntries(dates.map((date) => [date, 0]));
    for (const word of state.words) {
      const date = localDateString(new Date(word.createdAt));
      if (date in added) added[date] += 1;
    }
    for (const entry of state.meta.answerHistory || []) {
      if (entry.date in answered) answered[entry.date] += 1;
    }
    return {
      dates,
      added: dates.map((date) => added[date]),
      answered: dates.map((date) => answered[date])
    };
  }

  function drawDailyBarChart(canvas, dates, values, accentColor) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const styles = getComputedStyle(document.documentElement);
    const textColor = styles.getPropertyValue("--muted").trim() || "#6e6e73";
    const lineColor = styles.getPropertyValue("--line").trim() || "rgba(60,60,67,.14)";
    const padding = { top: 14, right: 8, bottom: 34, left: 34 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const maximum = Math.max(1, ...values);
    const step = chartWidth / values.length;
    const barWidth = Math.max(2, Math.min(13, step * 0.62));

    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let line = 0; line <= 4; line++) {
      const value = Math.round(maximum * (4 - line) / 4);
      const y = padding.top + chartHeight * line / 4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(String(value), padding.left - 7, y);
    }

    values.forEach((value, index) => {
      const barHeight = value ? Math.max(3, value / maximum * chartHeight) : 0;
      const x = padding.left + step * index + (step - barWidth) / 2;
      const y = padding.top + chartHeight - barHeight;
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      const radius = Math.min(4, barWidth / 2, barHeight / 2);
      if (barHeight > 0 && ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, [radius, radius, 0, 0]);
      else ctx.rect(x, y, barWidth, barHeight);
      ctx.fill();
    });

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelIndexes = [0, 5, 10, 15, 20, 25, 29];
    for (const index of labelIndexes) {
      const [, month, day] = dates[index].split("-");
      const x = padding.left + step * index + step / 2;
      ctx.fillText(`${Number(month)}/${Number(day)}`, x, padding.top + chartHeight + 9);
    }
  }

  function renderAnalysis() {
    if (!$("#addedWordsChart") || !$("#answeredQuestionsChart")) return;
    const series = analyticsSeries();
    const addedTotal = series.added.reduce((sum, value) => sum + value, 0);
    const answeredTotal = series.answered.reduce((sum, value) => sum + value, 0);
    $("#analysisAddedTotal").textContent = addedTotal;
    $("#analysisAnsweredTotal").textContent = answeredTotal;
    $("#addedChartTotal").textContent = `${addedTotal}語`;
    $("#answeredChartTotal").textContent = `${answeredTotal}問`;
    const styles = getComputedStyle(document.documentElement);
    drawDailyBarChart($("#addedWordsChart"), series.dates, series.added, styles.getPropertyValue("--blue").trim() || "#007aff");
    drawDailyBarChart($("#answeredQuestionsChart"), series.dates, series.answered, styles.getPropertyValue("--green").trim() || "#34c759");
  }

  function refreshAll() {
    updateSummary();
    renderWordList();
    renderToday();
    renderStorageStatus();
    renderNotificationSettings();
    renderAnalysis();
    updateBackupReminder();
    if ($("#quizSetupView") && !$("#quizSetupView").hidden) updateQuizSetupAvailability();
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const now = new Date();
    state.meta.lastBackupAt = now.toISOString();
    state.meta.changesSinceBackup = 0;
    state.meta.backupReminderDismissedAt = null;
    const payload = {
      version: APP_DATA_VERSION,
      exportedAt: now.toISOString(),
      words: state.words,
      meta: state.meta
    };
    downloadFile(
      `word-study-backup-${localDateString(now)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    saveData({ changeAmount: 0 });
    if ($("#dataNotice")) showNotice($("#dataNotice"), "JSONバックアップを書き出した。", "success");
  }

  function csvEscape(value) {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function exportCsv() {
    const header = ["english", "japanese", "correct", "mistakes", "mistakeHistory", "reviewDates", "createdAt"];
    const rows = state.words.map((word) => [
      word.english, word.japanese, word.correct, word.mistakes,
      (word.mistakeHistory || []).join("|"),
      (word.reviewDates || []).join("|"),
      new Date(word.createdAt).toISOString()
    ]);
    const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadFile(`word-list-${localDateString()}.csv`, csv, "text/csv;charset=utf-8");
  }

  async function importJson(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.words)) throw new Error("words配列がない");
      const imported = normalizeWords(parsed.words);
      if (!imported.length && parsed.words.length) throw new Error("有効な単語がない");
      if (!confirm(`バックアップ内の${imported.length}語で現在のデータを上書きするか？`)) return;

      state.words = imported;
      state.currentQuizWordId = null;
      state.meta = {
        ...normalizeMeta(parsed.meta),
        firstUsedAt: state.meta.firstUsedAt || new Date().toISOString(),
        lastBackupAt: new Date().toISOString(),
        changesSinceBackup: 0,
        backupReminderDismissedAt: null,
        storagePersisted: state.meta.storagePersisted
      };
      await saveData({ changeAmount: 0 });
      showNotice($("#dataNotice"), `${imported.length}語を読み込んだ。`, "success");
    } catch (error) {
      console.error(error);
      showNotice($("#dataNotice"), "読み込みに失敗した。正しいバックアップJSONか確認する必要がある。", "error");
    } finally {
      $("#importInput").value = "";
    }
  }

  function parseBulkLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.includes("\t")) {
      const [english, ...rest] = trimmed.split("\t");
      return [english, rest.join("\t")];
    }
    const commaIndex = trimmed.search(/[,，]/);
    if (commaIndex >= 0) return [trimmed.slice(0, commaIndex), trimmed.slice(commaIndex + 1)];
    return null;
  }

  function formatDateTime(value) {
    if (!value) return "未実施";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未実施";
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(date);
  }

  function daysSince(value) {
    if (!value) return Infinity;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return Infinity;
    return Math.floor((Date.now() - time) / 86400000);
  }

  function notificationPermissionLabel() {
    if (!("Notification" in window)) return "このブラウザは通知に対応していない";
    if (Notification.permission === "denied") return "通知が拒否されている。ブラウザ設定から許可が必要";
    if (!state.meta.notificationEnabled) return "通知は無効";
    if (!state.meta.notificationTimes.length) return "通知時刻が未設定";
    return `通知有効: ${state.meta.notificationTimes.join("、")}`;
  }

  function renderNotificationSettings() {
    const times = state.meta.notificationTimes || [];
    for (let index = 0; index < 3; index++) {
      const input = $(`#notificationTime${index + 1}`);
      if (input && document.activeElement !== input) input.value = times[index] || "";
    }
    if ($("#notificationStatus")) $("#notificationStatus").textContent = notificationPermissionLabel();
  }

  function dueTodayCount() {
    return state.words.filter(isDueToday).length;
  }

  async function displayTodayNotification(count) {
    if (!("Notification" in window) || Notification.permission !== "granted" || count <= 0) return false;
    const title = `今日の単語 あと${count}個`;
    const options = {
      body: "今日の学習対象が残っている。",
      icon: "./icons/icon-192-v3.png",
      badge: "./icons/icon-192-v3.png",
      tag: "word-study-today",
      renotify: true,
      data: { url: "./#today" }
    };
    try {
      if (navigator.serviceWorker) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
      return true;
    } catch (error) {
      console.warn("通知表示に失敗:", error);
      return false;
    }
  }

  async function checkScheduledNotifications({ catchUp = false } = {}) {
    if (!("Notification" in window)) return;
    if (!state.meta.notificationEnabled || Notification.permission !== "granted") return;
    const times = state.meta.notificationTimes || [];
    if (!times.length) return;
    const count = dueTodayCount();
    if (!count) return;

    const now = new Date();
    const today = localDateString(now);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const unsent = times.filter((time) => state.meta.notificationSent?.[time] !== today);
    let target = null;

    if (catchUp) {
      const past = unsent.filter((time) => time <= currentTime);
      target = past.at(-1) || null;
      if (target) {
        for (const time of past) state.meta.notificationSent[time] = today;
      }
    } else {
      target = unsent.find((time) => time === currentTime) || null;
      if (target) state.meta.notificationSent[target] = today;
    }

    if (!target) return;
    const shown = await displayTodayNotification(count);
    if (shown) await saveData({ changeAmount: 0 });
  }

  function startNotificationScheduler() {
    if (notificationTimer) clearInterval(notificationTimer);
    notificationTimer = setInterval(() => checkScheduledNotifications(), NOTIFICATION_CHECK_INTERVAL_MS);
  }

  async function saveNotificationSettings() {
    const times = [1, 2, 3]
      .map((index) => $(`#notificationTime${index}`)?.value || "")
      .filter(Boolean);
    state.meta.notificationTimes = [...new Set(times)].sort().slice(0, 3);

    if (!("Notification" in window)) {
      state.meta.notificationEnabled = false;
      await saveData({ changeAmount: 0 });
      renderNotificationSettings();
      return;
    }

    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    state.meta.notificationEnabled = permission === "granted" && state.meta.notificationTimes.length > 0;
    await saveData({ changeAmount: 0 });
    renderNotificationSettings();
    if (state.meta.notificationEnabled) await checkScheduledNotifications({ catchUp: true });
  }

  async function disableNotifications() {
    state.meta.notificationEnabled = false;
    await saveData({ changeAmount: 0 });
    renderNotificationSettings();
  }

  function updateBackupReminder() {
    const banner = $("#backupBanner");
    if (!banner || !state.words.length) {
      if (banner) banner.hidden = true;
      return;
    }

    const referenceDate = state.meta.lastBackupAt || state.meta.firstUsedAt;
    const age = daysSince(referenceDate);
    const dueByDays = age >= BACKUP_DAY_THRESHOLD;
    const dueByChanges = state.meta.changesSinceBackup >= BACKUP_CHANGE_THRESHOLD;
    const snoozed = state.meta.backupReminderDismissedAt && daysSince(state.meta.backupReminderDismissedAt) < BACKUP_SNOOZE_DAYS;
    const due = (dueByDays || dueByChanges) && !snoozed;
    banner.hidden = !due;
    if (!due) return;

    const reasons = [];
    if (dueByDays) reasons.push(`前回のバックアップ基準から${age}日経過`);
    if (dueByChanges) reasons.push(`${state.meta.changesSinceBackup}件の変更`);
    $("#backupBannerText").textContent = `${reasons.join("・")}している。端末内へJSONを保存する。`;
  }

  async function renderStorageStatus() {
    if (!$("#databaseStatus")) return;
    $("#databaseStatus").textContent = database ? "IndexedDBへ自動保存中" : "IndexedDBを利用できない";
    $("#databaseDetail").textContent = `${state.words.length}語・最終保存 ${formatDateTime(state.meta.lastSavedAt)}`;

    if (state.meta.storagePersisted === true) {
      $("#persistenceStatus").textContent = "有効";
      $("#persistenceDetail").textContent = "ブラウザによる自動削除を抑制";
    } else if (state.meta.storagePersisted === false) {
      $("#persistenceStatus").textContent = "未許可";
      $("#persistenceDetail").textContent = "JSONバックアップを推奨";
    } else {
      $("#persistenceStatus").textContent = "非対応または未確認";
      $("#persistenceDetail").textContent = "通常のIndexedDB保存は継続";
    }

    $("#lastBackupStatus").textContent = formatDateTime(state.meta.lastBackupAt);
    $("#backupChangeStatus").textContent = `バックアップ後の変更: ${state.meta.changesSinceBackup}件`;

    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage || 0;
        $("#storageUsageStatus").textContent = usage < 1024 * 1024
          ? `${Math.max(1, Math.round(usage / 1024))} KB`
          : `${(usage / 1024 / 1024).toFixed(1)} MB`;
      } else {
        $("#storageUsageStatus").textContent = "取得不可";
      }
    } catch {
      $("#storageUsageStatus").textContent = "取得不可";
    }
  }

  async function requestPersistentStorage(showResult = false) {
    const warning = $("#storageWarning");
    if (!navigator.storage?.persisted || !navigator.storage?.persist) {
      state.meta.storagePersisted = null;
      if (warning) warning.hidden = false;
      renderStorageStatus();
      return false;
    }

    try {
      let persisted = await navigator.storage.persisted();
      if (!persisted) persisted = await navigator.storage.persist();
      state.meta.storagePersisted = persisted;
      if (warning) warning.hidden = persisted;
      await saveData({ changeAmount: 0 });
      if (showResult && $("#dataNotice")) {
        showNotice(
          $("#dataNotice"),
          persisted ? "保存保護が有効になった。" : "ブラウザが保存保護を許可しなかった。JSONバックアップを併用する必要がある。",
          persisted ? "success" : "error"
        );
      }
      return persisted;
    } catch (error) {
      console.warn("永続ストレージ要求に失敗:", error);
      state.meta.storagePersisted = false;
      if (warning) warning.hidden = false;
      renderStorageStatus();
      return false;
    }
  }

  function setupPwaInstall() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      $("#installBtn").hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      $("#installBtn").hidden = true;
    });
  }

  async function installPwa() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installBtn").hidden = true;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Service Worker登録失敗:", error);
    });
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const speakButton = event.target.closest("[data-speak]");
      if (speakButton) {
        event.preventDefault();
        speakEnglish(speakButton.dataset.speak);
        return;
      }
      const spellButton = event.target.closest("[data-spell-suggestion]");
      if (spellButton) {
        event.preventDefault();
        $("#englishInput").value = spellButton.dataset.spellSuggestion;
        clearRegistrationWarning();
        renderSpellStatus();
        $("#englishInput").focus();
      }
    });
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
    $$('[data-open-tab]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.openTab)));
    $$('[data-register-mode]').forEach((button) => button.addEventListener("click", () => showRegistrationMode(button.dataset.registerMode)));
    $$('[data-registration-back]').forEach((button) => button.addEventListener("click", showRegistrationChooser));
    $("#settingsBtn")?.addEventListener("click", openSettings);
    $("#settingsCloseBtn")?.addEventListener("click", closeSettings);
    $("#settingsDialog")?.addEventListener("click", (event) => {
      if (event.target === $("#settingsDialog")) closeSettings();
    });

    $("#addForm").addEventListener("submit", (event) => {
      event.preventDefault();
      attemptSingleAdd(true);
    });

    $("#addAndContinueBtn").addEventListener("click", () => attemptSingleAdd(true));
    $("#speakEnglishInputBtn").addEventListener("click", () => speakEnglish($("#englishInput").value));

    $("#englishInput").addEventListener("input", scheduleSpellStatusCheck);
    $("#englishInput").addEventListener("blur", renderSpellStatus);
    $("#applySpellSuggestionBtn").addEventListener("click", () => {
      const pending = state.pendingRegistration;
      const suggestion = pending?.details?.suggestions?.[0];
      if (!pending || !suggestion) return;
      $("#englishInput").value = suggestion;
      clearRegistrationWarning();
      renderSpellStatus();
      attemptSingleAdd(pending.focusEnglish);
    });
    $("#confirmRegistrationBtn").addEventListener("click", () => {
      const pending = state.pendingRegistration;
      if (!pending) return;
      if (pending.type === "spelling") {
        clearRegistrationWarning();
        attemptSingleAdd(pending.focusEnglish, { bypassSpelling: true });
      } else if (pending.type === "same-english") {
        finishSingleAdd(addWord(pending.english, pending.japanese), pending.focusEnglish);
      }
    });
    $("#cancelRegistrationWarningBtn").addEventListener("click", () => {
      clearRegistrationWarning();
      $("#englishInput").focus();
      $("#englishInput").select();
    });

    $("#bulkAddBtn").addEventListener("click", () => {
      clearBulkSpellWarning();
      renderBulkDuplicateReport([]);
      const lines = $("#bulkInput").value.split(/\r?\n/);
      let added = 0;
      let skipped = 0;
      const spellWarnings = [];
      const duplicateItems = [];
      for (const line of lines) {
        const parsed = parseBulkLine(line);
        if (!parsed) {
          if (line.trim()) skipped++;
          continue;
        }
        const english = parsed[0].trim();
        const japanese = parsed[1].trim();
        if (!english || !japanese) {
          skipped++;
          continue;
        }
        const duplicates = duplicateStatus(english, japanese);
        if (duplicates.exact) {
          skipped++;
          duplicateItems.push({ english, japanese, type: "exact" });
          continue;
        }
        const spelling = checkEnglishSpelling(english);
        if (spelling.status === "warning") {
          spellWarnings.push({ english, japanese, spelling });
          continue;
        }
        if (duplicates.sameEnglish.length) {
          duplicateItems.push({ english, japanese, type: "same", existing: duplicates.sameEnglish.map((word) => word.japanese) });
        }
        const result = addWord(english, japanese);
        result.ok ? added++ : skipped++;
      }
      if (duplicateItems.length) renderBulkDuplicateReport(duplicateItems);
      const warningText = spellWarnings.length ? `、${spellWarnings.length}語はスペル確認待ち` : "";
      showNotice($("#bulkNotice"), `${added}語を追加、${skipped}行をスキップ${warningText}。`, added ? "success" : (spellWarnings.length ? "" : "error"));
      if (spellWarnings.length) showBulkSpellWarnings(spellWarnings);
      else if (added) $("#bulkInput").value = "";
    });

    $("#useBulkSpellSuggestionsBtn").addEventListener("click", () => registerPendingBulkSpell(true));
    $("#keepBulkSpellingsBtn").addEventListener("click", () => registerPendingBulkSpell(false));
    $("#cancelBulkSpellWarningBtn").addEventListener("click", clearBulkSpellWarning);


    $("#copyAiPromptBtn").addEventListener("click", async () => {
      const promptText = $("#aiReadPrompt").value;
      try {
        await navigator.clipboard.writeText(promptText);
        showNotice($("#aiPromptNotice"), "文章をコピーした。AIのチャット画面へ貼り付け、ノート画像と一緒に送信する。", "success");
      } catch (error) {
        $("#aiReadPrompt").focus();
        $("#aiReadPrompt").select();
        const copied = document.execCommand("copy");
        showNotice(
          $("#aiPromptNotice"),
          copied ? "文章をコピーした。" : "自動コピーできない。文章を長押しまたは選択してコピーする必要がある。",
          copied ? "success" : "error"
        );
      }
    });

    $("#startTodayBtn").addEventListener("click", () => {
      $("#quizDirection").value = $("#todayQuizDirection").value;
      switchTab("quiz", { quizMode: "today", autoStart: true });
    });
    $("#startQuizBtn").addEventListener("click", startQuizFromSetup);

    $("#quizEmptyAction").addEventListener("click", () => {
      if ($("#quizEmptyAction").dataset.action === "restart") {
        resetQuizSession();
        showQuizPlayView();
        startQuizSession();
      } else {
        switchTab("add");
      }
    });

    $("#quizDirection").addEventListener("change", () => {
      $("#todayQuizDirection").value = $("#quizDirection").value;
      updateQuizSetupAvailability();
    });
    $("#todayQuizDirection").addEventListener("change", () => {
      $("#quizDirection").value = $("#todayQuizDirection").value;
    });
    $("#quizRange").addEventListener("change", () => {
      state.quizRangeOverride = null;
      updateQuizCountControl();
      updateQuizSetupAvailability();
    });
    $("#quizOrder").addEventListener("change", updateQuizSetupAvailability);
    $("#quizCount").addEventListener("change", () => {
      updateQuizCountControl();
      updateQuizSetupAvailability();
    });
    $("#checkBtn").addEventListener("click", checkAnswer);
    $("#manualJudgeRow").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.id === "markCorrectBtn") resolveManualJudgement(true);
      if (button.id === "markWrongBtn") resolveManualJudgement(false);
    });
    $("#showAnswerBtn").addEventListener("click", revealAnswer);
    $("#nextBtn").addEventListener("click", () => chooseNextQuestion());
    $("#answerInput").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (state.manualJudgePending) return;
      state.answered ? chooseNextQuestion() : checkAnswer();
    });

    $("#searchInput").addEventListener("input", renderWordList);
    $("#listSort").addEventListener("change", renderWordList);

    $("#wordTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const word = state.words.find((item) => item.id === button.dataset.id);
      if (!word) return;

      if (button.dataset.action === "delete") {
        if (!confirm(`「${word.english}」を削除するか？\n正誤記録と復習予定も削除される。`)) return;
        state.words = state.words.filter((item) => item.id !== word.id);
        resetQuizSession();
        saveData();
        showNotice($("#listNotice"), `「${word.english}」を削除した。`, "success");
      }
      if (button.dataset.action === "edit") {
        $("#editId").value = word.id;
        $("#editEnglish").value = word.english;
        $("#editJapanese").value = word.japanese;
        $("#editDialog").showModal();
        $("#editEnglish").focus();
      }
    });

    $("#mistakeTable")?.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="reset"]');
      if (!button) return;
      const word = state.words.find((item) => item.id === button.dataset.id);
      if (!word) return;
      word.correct = 0;
      word.mistakes = 0;
      word.mistakeHistory = [];
      word.reviewDates = [];
      saveData();
    });

    $("#editForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const word = state.words.find((item) => item.id === $("#editId").value);
      if (!word) return;
      const english = $("#editEnglish").value.trim();
      const japanese = $("#editJapanese").value.trim();
      if (!english || !japanese) return;
      const previousEnglish = word.english;
      word.english = english;
      word.japanese = japanese;
      saveData();
      $("#editDialog").close();
      showNotice($("#listNotice"), `「${previousEnglish}」を更新した。`, "success");
    });
    $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());

    $("#exportBtn").addEventListener("click", exportJson);
    $("#exportBtn2").addEventListener("click", exportJson);
    $("#backupNowBtn").addEventListener("click", exportJson);
    $("#dismissBackupBtn").addEventListener("click", () => {
      state.meta.backupReminderDismissedAt = new Date().toISOString();
      saveData({ changeAmount: 0 });
    });
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#importInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) importJson(file);
    });

    const retryPersist = () => requestPersistentStorage(true);
    $("#retryPersistBtn").addEventListener("click", retryPersist);
    $("#retryPersistBtn2").addEventListener("click", retryPersist);
    $("#installBtn").addEventListener("click", installPwa);
    $("#saveNotificationSettingsBtn").addEventListener("click", saveNotificationSettings);
    $("#disableNotificationsBtn").addEventListener("click", disableNotifications);
    let analysisResizeTimer = null;
    window.addEventListener("resize", () => {
      if (analysisResizeTimer) clearTimeout(analysisResizeTimer);
      analysisResizeTimer = setTimeout(() => {
        if ($("#panel-analysis")?.classList.contains("active")) renderAnalysis();
      }, 120);
    });

    $("#clearAllBtn").addEventListener("click", () => {
      if (!state.words.length) {
        showNotice($("#dataNotice"), "削除するデータがない。");
        return;
      }
      if (!confirm("登録単語と全学習記録を削除する。この操作は元に戻せない。")) return;
      state.words = [];
      state.meta.answerHistory = [];
      resetQuizSession();
      saveData();
      showNotice($("#dataNotice"), "全データを削除した。", "success");
    });
  }

  async function initialize() {
    setupPwaInstall();
    bindEvents();
    registerServiceWorker();
    await loadData();
    refreshAll();
    await requestPersistentStorage(false);
    refreshAll();
    startNotificationScheduler();
    await checkScheduledNotifications({ catchUp: true });
    switchTab(location.hash === "#today" ? "today" : "today");

    if (state.meta.migratedFromLocalStorage) {
      showNotice($("#dataNotice"), "旧版のlocalStorageデータをIndexedDBへ自動移行した。", "success");
      state.meta.migratedFromLocalStorage = false;
      saveData({ changeAmount: 0 });
    }
  }

  initialize();
})();
