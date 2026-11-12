# ORPHE INSOLE β sample data

https://orphe-oss.github.io/ORPHE-CORE-INSOLE.js/sample-data/ (Japanese) / https://orphe-oss.github.io/ORPHE-CORE-INSOLE.js/en/sample-data/ (English)

[日本語](#日本語) / [English](#english)

## 日本語

ORPHE INSOLE β（左右）で記録した、通常歩行・病的歩行の模擬 8 種・トレッドミル走行 3 速度のサンプルデータです。

- 計測日：2026 年 10 月 21 日
- デバイス：ORPHE INSOLE β（左右）。208.3 Hz
- カメラ：iPhone ARKit ボディトラッキング（約 30 fps、91 関節）と撮影動画（顔にモザイク処理済み）
- 被験者：健常者 1 名による**模擬**です。病的歩行は左足を患側として模擬し、小刻み歩行・すくみ足・ハサミ足は左右とも同じ動きで模擬しています。臨床的な代表値ではありません
- 試技：歩行はカメラに向かって約 5 m の直線歩行、走行はトレッドミル。各試技の冒頭に両脚ジャンプ（同期用）があります

### 利用条件

本データの著作権は ORPHE Inc. に帰属します（Copyright (C) 2026 ORPHE Inc.）。

1. **使える範囲**：教育・ワークショップ、大学・研究機関などでの非商用研究、個人制作、試作・社内検証に、無償で使えます
2. **商用利用**：有料の製品・サービスの開発や評価に使う場合は、事前に ORPHE（https://orphe.io/）にご相談ください
3. **再配布の禁止**：データそのもの（CSV・JSON・動画・画像）を再配布しないでください。共有するときは、上記のサンプルデータのページへのリンクを案内してください。データから作った図表・統計値・解析結果は、論文や発表に使えます
4. **禁止事項**：被験者を特定しようとすること、モザイクを外したり元の映像を復元しようとしたりすること、動画や画像を人物の識別や生成モデルの学習に使うこと
5. **出典の表示**：論文・発表・公開物で使うときは「ORPHE INSOLE サンプルデータ（ORPHE Inc., 2026）」とサンプルデータのページの URL を記載してください
6. **医療用途ではありません**：模擬による参考データで、臨床の基準値ではありません。ORPHE INSOLE は医療機器ではなく、診断・治療の根拠には使えません
7. **無保証・変更**：データは現状のまま提供し、正確性を保証しません。予告なく内容を変更したり、公開を停止したりすることがあります

### ファイル

| ファイル | 内容 |
| --- | --- |
| `sensor-left.csv` / `sensor-right.csv` | センサー値（`timestamp` [s, UNIX 時刻]、`accX/Y/Z` [G]、`gyroX/Y/Z` [dps]、`quatW/X/Y/Z`、`press1`〜`press6` [N]、`serialNumber`、`keyPoint`） |
| `gait_analysis_{left,right}_detailed.csv` | アプリが算出した 1 ストライドごとの歩容指標 |
| `landmarks.json` | ARKit 骨格（カメラ原点からの 3D 関節位置 [m]、約 30 fps） |
| `video.mp4` / `poster.jpg` | 動画とサムネイル（顔にモザイク処理済み） |
| `trial.json` | 試技名と時刻合わせの値（下記） |
| `trials.csv` | 全試技の `trial.json` を 1 表にしたもの（一括 ZIP のみ） |

### 座標系と圧力センサー

右手系・Z 上向きで左右共通です。Y = つま先方向、X = つま先に向かって右、Z = 上（静止時 accZ ≈ +1 G）。X は左右とも「右」向きなので、+X は左足では内側、右足では外側です。左右を解剖学的にそろえるときは、左足の accX・gyroY・gyroZ の符号を反転してください。

圧力センサー：1 つま先内側、2 母趾球内側、3 つま先外側、4 中足部中央、5 中足部外側、6 踵。

### 時刻の合わせ方

左右のインソールと動画は別々の時計で記録されています。`trial.json` の `sync` で次のように合わせます（t = 0 は左足のジャンプ着地）。

- 左足：`t = timestamp − tZeroUnix`
- 右足：`t = timestamp − rightOffsetMs / 1000 − tZeroUnix`（ジャンプの着地衝撃を左右で相互相関。精度の目安 ±10 ms）
- 動画：`動画の再生位置 [s] = t + (tZeroUnix − videoStartUnix) + videoOffsetS`

`videoOffsetS` は、ARKit 骨格の腰の上下動から求めた動画上のジャンプ着地と、センサーの着地の差です（精度の目安は ±1 フレーム）。`videoOffsetMethod` が `median` の試技は、ジャンプ中に骨格の追跡が途切れたため、ほかの試技の中央値を使っています。

### 注意事項

- 圧力は約 9 N 未満が 0 になり、静止立位の合計も 10〜20 N 程度です。絶対荷重ではなく、荷重の分布とタイミングとして見てください。本データではセンサー 4 がほぼ応答していません
- アプリ出力の `landingForce` は全行 0（未算出）です
- `footAngle` の符号の定義は確認中です。条件間・左右の変化量として見てください
- トレッドミル上の歩幅・速度はベルト速度（1.67 / 2.50 / 3.33 m/s）より 9〜16% 低く出ます

## English

Sample data recorded with a pair of ORPHE INSOLE β: normal walking, 8 simulated pathological gaits, and treadmill running at 3 speeds.

- Recorded on 21 October 2026
- Device: ORPHE INSOLE β (left and right), 208.3 Hz
- Camera: iPhone ARKit body tracking (about 30 fps, 91 joints) and video (faces are mosaicked)
- Subject: one healthy adult **simulating** each gait. Unilateral gaits simulate the left foot as the affected side; short-stepping, freezing and scissor gaits use the same movement on both feet. These are not clinically representative values
- Walking trials are about 5 m straight toward the camera; running trials are on a treadmill. Each trial starts with a two-footed jump for synchronization

### Terms of use

The data is copyright ORPHE Inc. (Copyright (C) 2026 ORPHE Inc.).

1. **Permitted use**: free for education and workshops, academic and non-commercial research, personal creative projects, and prototypes and internal experiments
2. **Commercial use**: to use the data to develop or evaluate a paid product or service, contact ORPHE (https://orphe.io/) beforehand
3. **No redistribution**: do not redistribute the data itself (CSV, JSON, video, images). To share it, link to the sample data page above. Figures, statistics and analysis results derived from the data may be used in papers and presentations
4. **Prohibited**: attempting to identify the subject, removing the mosaic or recovering the original video, and using the video or images to identify people or to train generative models
5. **Attribution**: when you use the data in a paper, presentation or publication, cite “ORPHE INSOLE sample data (ORPHE Inc., 2026)” with the URL of the sample data page
6. **Not for medical use**: this is simulated reference data, not clinical reference values. ORPHE INSOLE is not a medical device and must not be used as a basis for diagnosis or treatment
7. **No warranty; changes**: the data is provided “as is”, without warranty of accuracy. Its content may change, or publication may stop, without notice

### Files

| File | Content |
| --- | --- |
| `sensor-left.csv` / `sensor-right.csv` | Sensor values (`timestamp` [s, UNIX time], `accX/Y/Z` [G], `gyroX/Y/Z` [dps], `quatW/X/Y/Z`, `press1`–`press6` [N], `serialNumber`, `keyPoint`) |
| `gait_analysis_{left,right}_detailed.csv` | Per-stride gait metrics computed by the app |
| `landmarks.json` | ARKit skeleton (3D joint positions from the camera origin [m], about 30 fps) |
| `video.mp4` / `poster.jpg` | Video and thumbnail (faces are mosaicked) |
| `trial.json` | Trial name and synchronization values (below) |
| `trials.csv` | All `trial.json` files in one table (full archive only) |

### Coordinate system and pressure sensors

Right-handed and Z-up, the same for both feet. Y points toward the toes, X to the right of the toe direction, Z up (accZ ≈ +1 G at rest). Because X points right on both feet, +X is medial on the left foot and lateral on the right foot. To align the feet anatomically, flip the sign of accX, gyroY and gyroZ on the left foot.

Pressure sensors: 1 toe (medial), 2 ball (medial), 3 toe (lateral), 4 midfoot (center), 5 midfoot (lateral), 6 heel.

### Synchronization

The insoles and the video are recorded on separate clocks. Use `sync` in `trial.json` (t = 0 is the left-foot jump landing):

- Left foot: `t = timestamp − tZeroUnix`
- Right foot: `t = timestamp − rightOffsetMs / 1000 − tZeroUnix` (cross-correlation of the jump landing impact; about ±10 ms)
- Video: `video time [s] = t + (tZeroUnix − videoStartUnix) + videoOffsetS`

`videoOffsetS` is the difference between the jump landing in the video, found from the vertical motion of the ARKit root (pelvis) joint, and the landing in the sensor data (about ±1 frame). When `videoOffsetMethod` is `median`, body tracking dropped out during the jump and the median of the other trials is used.

### Notes

- Pressure below about 9 N reads as 0, and the total during quiet standing is only 10–20 N. Read it as load distribution and timing, not absolute load. Sensor 4 barely responds in this data
- `landingForce` in the app output is 0 on every row (not computed)
- The sign convention of `footAngle` is still being confirmed. Compare it across conditions or feet
- On the treadmill, stride length and speed read 9–16% below the belt speed (1.67 / 2.50 / 3.33 m/s)
