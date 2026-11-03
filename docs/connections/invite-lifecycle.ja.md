# 招待ストアのライフサイクル

[English](invite-lifecycle.md)

`InviteStore` の復旧は署名者とデータルートごとのローカル操作です。結果・エラーに秘密の文字列を含めません。
既存の file/keychain 選択と、所有者だけが利用できるメタデータのアトミックな置換を維持します。
relay のデプロイは不要です。

## 削除の再試行

`remove(workerRef)` はストアのロック中に参照先の文字列を削除し、欠落を確認してからメタデータを置換します。
削除・読戻しに失敗すると `INVITE_SECRET_DELETE_FAILED` を返し、メタデータを変更しません。
ストアを開き直した後も、同じ別名・参照で再試行できます。CLI の `invites remove` と MCP の
`acp_remove_invite` も同じ操作を使います。

文字列が既にない場合も削除を継続します。文字列の削除後に置換が失敗・プロセスが停止すると、
メタデータに欠落した文字列への参照が残る場合があります。`list()`・`resolve()` は
`INVITE_SECRET_MISSING` を返しますが、`remove` はメタデータだけを読み、削除を完了できます。
完了時は `true`、その後の再実行は `false` です。注入する `SecretStore.delete` は既にない項目も扱ってください。
エラーにバックエンドの例外文は含めません。

この順序は再試行に必要な参照を残します。旧実装がメタデータを削除済みの文字列や、取込・移行が
メタデータの公開前に中断して残した文字列を列挙・回収するものではありません。

## 組み込みホストの確認待ち取込

通常の `import(link, alias?)` は保存を確定し、従来の version 1 形式を書きます。
確認の途中で放棄された取込を整理したいホストは明示的に指定します。

```ts
const store = await InviteStore.open(owner, { ...identityOptions, keyStore: 'keychain' });
const saved = store.import(link, alias, { pendingConfirmation: true });
// 所有者には saved の情報だけを表示。取込は接続同意ではありません。
const pending = store.listUnconfirmed();
// 明示的な保存、または接続・利用の処理に渡す前に確定:
store.retain(saved.workerRef);
// 接続・委任は別途、従来の所有者承認を経て実行。
// 再起動後などに放棄された確認待ちを明示的に整理:
const result = store.removeUnconfirmed({ olderThan: '2026-11-01T00:00:00.000Z' });
```

新規項目だけに署名付きの `importState: 'unconfirmed'` を付け、`SavedInvite` に任意項目として返します。
トークンは含めません。`importedAt` は元の取込日時を維持します。確認待ちとしての再取込は過去の保存を
確認待ちへ戻しません。通常の import で重複した場合は明示的な保存としてマーカーを外します。

`retain(workerRef)` はストアのロック中にマーカーを外し、`SavedInvite` を返します。冪等で、参照がなければ
`INVITE_NOT_FOUND` です。接続やタスクへの同意は付けません。確認待ちの `resolve` は
`INVITE_CONFIRMATION_REQUIRED` となるため、利用前に保存を確定します。利用のために返した招待を整理の
対象にせず、解決・送信経路に書込や fsync を追加しません。`connections confirm-invite` は解決前に保存を
確定します。その後の所有者確認が拒否・通信が失敗した場合も、整理の対象外として保守的に保持します。
所有者の接続確認は従来どおり必要です。

`listUnconfirmed()` は秘密を取得せず署名付きメタデータを読み、削除中断後にも使えます。
`removeUnconfirmed({ olderThan })` は注入した時計または現在時刻以前の解析可能な日時を受け付けます。
不正・未来の値は `INVITE_CLEANUP_INVALID_CUTOFF` です。マーカーがあり、`importedAt` が指定日時より
厳密に古い項目だけを削除し、`{ removed: number }` を返します。同時刻・新しい項目、保存確定・利用済み、
マーカーのない旧項目は残します。期限切れだけでは対象にしません。整理と保存確定は従来の排他ロックと
置換処理を共有し、自動では整理しません。

選んだ全項目の文字列を削除してから、一度だけメタデータを置換します。途中で失敗するとメタデータを維持しますが、
一部の文字列は既にない場合があります。`listUnconfirmed()` で参照を確認し、整理または `remove` を再試行できます。
keychain への移行もマーカーを維持します。既存の version 1 ファイルは読め、通常の重複保存はバイト列も維持します。
フィールドを厳密に検証する旧リーダーはマーカーを読めないため、確認待ちの処理には更新後の runtime を使ってください。
保存確定・削除でマーカーがなくなれば従来の形になります。通信形式・同意方針・CLI フラグ・MCP の道具は追加しません。
既存の一覧結果にも任意のマーカーが付き、確認待ちは保存確定まで参照による委任に使えません。
