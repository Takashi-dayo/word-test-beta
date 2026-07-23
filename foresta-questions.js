(() => {
  "use strict";

  // フォレスタモード専用問題。ユーザーが登録した単語とは完全に分離される。
  // 問題を追加するときは、次の形式で配列へ追加する。
  // { id: "foresta-20kyu-001", level: "kyu-20", english: "example", japanese: "例" }
  window.FORESTA_QUESTIONS = Object.freeze([
    // 現在は仕組みのみ。問題データは未追加。
  ]);
})();
