(function(global, factory) {
	typeof exports === "object" && typeof module !== "undefined" ? factory(exports) : typeof define === "function" && define.amd ? define(["exports"], factory) : (global = typeof globalThis !== "undefined" ? globalThis : global || self, factory(global.OrpheCoreInsoleJS = {}));
})(this, function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/modes/insole.ts
	/** SENSOR_VALUES のリアルタイム配信モード仕様 */
	var INSOLE_STREAMING_MODES = Object.freeze({
		1: Object.freeze({
			id: 1,
			sampleHz: 200,
			packetHz: 50,
			fields: Object.freeze({
				quat: true,
				gyro: true,
				acc: true,
				press: false
			}),
			label: "Orientation 200 Hz"
		}),
		3: Object.freeze({
			id: 3,
			sampleHz: 200,
			packetHz: 50,
			fields: Object.freeze({
				quat: false,
				gyro: true,
				acc: true,
				press: true
			}),
			label: "Pressure + IMU 200 Hz"
		}),
		4: Object.freeze({
			id: 4,
			sampleHz: 100,
			packetHz: 50,
			fields: Object.freeze({
				quat: true,
				gyro: true,
				acc: true,
				press: true
			}),
			label: "Full sensor 100 Hz"
		})
	});
	/**
	* INSOLE の取得モード一覧（FW による絞り込み前）。
	* `STREAMING_*` は SENSOR_VALUES のリアルタイム配信、`STEP_ANALYSIS` は歩容解析、
	* `FIFO` はロスレス収録に対応する。
	*/
	/**
	* FIFO 収録に対応した INSOLE FW の最小リリース日（`YYYYMMDD`）。
	* これより古い FW は FIFO のコマンドに応答しないため、モード候補から外す。
	*/
	var INSOLE_FIFO_MIN_RELEASE_DATE = 20260510;
	/**
	* 個体別の圧力校正係数を持つ INSOLE FW の最小リリース日（`YYYYMMDD`）。
	* これ以降の FW では begin() で係数を取得し、圧力の N 換算に使う。
	* それより古い FW（および FW 不明）は固定式で換算する。
	*/
	var INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE = 20260428;
	/**
	* INSOLE の取得モード一覧（FW による絞り込み前）。
	* `STREAMING_*` は SENSOR_VALUES のリアルタイム配信、`STEP_ANALYSIS` は歩容解析、
	* `FIFO` はロスレス収録に対応する。
	*/
	var INSOLE_MODES = Object.freeze([
		Object.freeze({
			id: "STREAMING_4",
			label: INSOLE_STREAMING_MODES[4].label,
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "STREAMING_3",
			label: INSOLE_STREAMING_MODES[3].label,
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "STREAMING_1",
			label: INSOLE_STREAMING_MODES[1].label,
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "STEP_ANALYSIS",
			label: "Gait analysis",
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "FIFO",
			label: "Lossless FIFO recording",
			minReleaseDate: INSOLE_FIFO_MIN_RELEASE_DATE
		})
	]);
	/**
	* `STREAMING_*` のモード id → streaming mode 番号。
	* それ以外の id では null（begin() の streamingMode 指定には使わない）。
	*/
	function insoleStreamingModeOf(id) {
		const matched = /^STREAMING_(\d+)$/.exec(id);
		if (!matched) return null;
		const mode = Number(matched[1]);
		return INSOLE_STREAMING_MODES[mode] ? mode : null;
	}
	//#endregion
	//#region src/ble/errors.ts
	/** code 付き Error（エラー種別のプログラム判定用） */
	var TransportError = class extends Error {
		/** エラー種別（メッセージ文字列に依存せず判定できる） */
		code;
		constructor(code, message) {
			super(message);
			this.name = "OrpheBleTransportError";
			this.code = code;
		}
	};
	//#endregion
	//#region src/protocol/commands.ts
	/**
	* DEVICE_INFORMATION characteristic へ書き込むコマンドの先頭バイト（オペコード）。
	* CORE / INSOLE の FW で共通。マジックナンバーはここだけで管理する。
	*/
	var DEVICE_INFORMATION_OPCODE = Object.freeze({
		/** デバイス設定（取付位置・LED 輝度・レンジなど）の書込 */
		WRITE_SETTINGS: 1,
		/** LED の点灯パターン（CORE） */
		SET_LED: 2,
		/** 姿勢（クォータニオン計算）のリセット（CORE） */
		RESET_ATTITUDE: 3,
		/** 解析ログ（歩数など）のリセット */
		RESET_ANALYSIS_LOGS: 4,
		/** データストリーミングモード（1 / 3 / 4）の切替（INSOLE） */
		SET_STREAMING_MODE: 13
	});
	//#endregion
	//#region src/protocol/advertisement.ts
	/** advertisementreceived のイベントを INSOLE の状態に変換する。INSOLE のデータでなければ null */
	function decodeInsoleAdvertisement(event) {
		const ad = event;
		const dv = ad?.manufacturerData?.get(0) ?? null;
		if (!dv || dv.byteLength < 18) return null;
		return {
			name: ad?.device?.name,
			rssi: ad?.rssi,
			txPower: ad?.txPower,
			id: ad?.device?.id ?? "",
			battery: dv.getUint8(14),
			model_type: dv.getUint8(5),
			mounting_position: dv.getUint8(6),
			human_activity_recognition: dv.getUint8(7),
			version: `${dv.getUint8(15)}.${dv.getUint8(16)}.${dv.getUint8(17)}`
		};
	}
	//#endregion
	//#region src/protocol/uuids.ts
	/** ORPHE デバイスの service / characteristic UUID（CORE・INSOLE 共通）。 */
	var ORPHE_UUID = {
		/** Orphe Information Service */
		INFORMATION_SERVICE: "01a9d6b5-ff6e-444a-b266-0be75e85c064",
		/** Device Information characteristic（Information Service 配下） */
		DEVICE_INFORMATION: "24354f22-1c46-430e-a4ab-a1eeabbcdfc0",
		/** Date Time characteristic（Information Service 配下） */
		DATE_TIME: "f53eeeb1-b2e8-492a-9673-10e0f1c29026",
		/** Orphe Other Service（センサーデータ系） */
		OTHER_SERVICE: "db1b7aca-cda5-4453-a49b-33a53d3f0833",
		/** Sensor Values characteristic（Other Service 配下） */
		SENSOR_VALUES: "f3f9c7ce-46ee-4205-89ac-abe64e626c0f",
		/** Step Analysis characteristic（Other Service 配下） */
		STEP_ANALYSIS: "4eb776dc-cf99-4af7-b2d3-ad0f791a79dd",
		/** Get FW Name characteristic（Other Service 配下・FW ビルド名の read） */
		GET_FW_NAME: "690ecd23-c460-4ce3-8b5c-c0de65eb02d2"
	};
	/** 論理名 → UUID ペアの標準テーブル（TransportConfig.characteristics 用） */
	function orpheCharacteristics() {
		return {
			DEVICE_INFORMATION: {
				serviceUUID: ORPHE_UUID.INFORMATION_SERVICE,
				characteristicUUID: ORPHE_UUID.DEVICE_INFORMATION
			},
			DATE_TIME: {
				serviceUUID: ORPHE_UUID.INFORMATION_SERVICE,
				characteristicUUID: ORPHE_UUID.DATE_TIME
			},
			SENSOR_VALUES: {
				serviceUUID: ORPHE_UUID.OTHER_SERVICE,
				characteristicUUID: ORPHE_UUID.SENSOR_VALUES
			},
			STEP_ANALYSIS: {
				serviceUUID: ORPHE_UUID.OTHER_SERVICE,
				characteristicUUID: ORPHE_UUID.STEP_ANALYSIS
			},
			GET_FW_NAME: {
				serviceUUID: ORPHE_UUID.OTHER_SERVICE,
				characteristicUUID: ORPHE_UUID.GET_FW_NAME
			}
		};
	}
	var REQUEST_COMMAND = 16;
	var REQUEST_ACTION = 0;
	var COEFFICIENT_COUNT = 5;
	/** 1ch ぶんの校正係数取得要求（DEVICE_INFORMATION へ write する） */
	function encodePressureCalibrationRequest(sensorIndex) {
		if (!Number.isInteger(sensorIndex) || sensorIndex < 0 || sensorIndex >= 6) throw new RangeError(`sensorIndex must be 0..5: ${sensorIndex}`);
		return Uint8Array.from([
			REQUEST_COMMAND,
			REQUEST_ACTION,
			sensorIndex
		]);
	}
	/** SENSOR_VALUES の notify が校正係数の応答かどうか（先頭バイトで判定） */
	function isPressureCalibrationPacket(data) {
		return data.byteLength > 0 && data.getUint8(0) === 57;
	}
	/**
	* 校正係数の notify をデコードする。
	* ヘッダ違いや長さ不足は null。
	*/
	function decodePressureCalibration(data) {
		if (!isPressureCalibrationPacket(data)) return null;
		if (data.byteLength < 43) return null;
		const coefficients = [];
		for (let i = 0; i < COEFFICIENT_COUNT; i++) coefficients.push(data.getFloat64(3 + 8 * i));
		return {
			sensorIndex: data.getUint8(1),
			calibration: {
				func: data.getUint8(2),
				coefficients
			}
		};
	}
	/**
	* FW に校正値が書かれていないときに返るプレースホルダかどうか。
	* `func = 0` かつ係数が全部 `1.0` のときは個体別係数として扱わず、旧式へ戻す。
	*/
	function isPressureCalibrationPlaceholder(calibration) {
		return calibration.func === 0 && calibration.coefficients.length === COEFFICIENT_COUNT && calibration.coefficients.every((c) => c === 1);
	}
	/**
	* 校正係数で ADC 生値を圧力 [N] に換算する。
	* 負・NaN・無限大・未知の func は 0。
	*/
	function applyPressureCalibration(calibration, adcRaw) {
		const c = calibration.coefficients;
		let y;
		switch (calibration.func) {
			case 0:
				if (c.length < 3) return 0;
				y = c[0] * Math.exp(c[1] * adcRaw) + c[2];
				break;
			case 1: {
				if (c.length < 5) return 0;
				const x2 = adcRaw * adcRaw;
				const x3 = x2 * adcRaw;
				const x4 = x3 * adcRaw;
				y = c[0] * x4 + c[1] * x3 + c[2] * x2 + c[3] * adcRaw + c[4];
				break;
			}
			default: return 0;
		}
		if (!Number.isFinite(y) || y < 0) return 0;
		return y;
	}
	var LEGACY_C1 = 2.77942;
	var LEGACY_C2 = .00208348;
	var LEGACY_C3 = 4.14411;
	/** ノイズフロア [mV]。これ以下は「踏んでいない」として 0 にする */
	var LEGACY_THRESHOLD_MV = 240;
	var ADC_REFERENCE_VOLT = 3.3;
	var ADC_FULL_SCALE = 4096;
	/**
	* 個体別係数を持たない FW 向けの換算。
	* `mV = adc × 3.3 / 4096 × 1000` に直し、240 mV 以下は 0、
	* それ以上は `c1·exp(c2·mV) + c3`。
	*/
	function legacyPressureToNewton(adcRaw) {
		const mV = adcRaw * ADC_REFERENCE_VOLT / ADC_FULL_SCALE * 1e3;
		if (mV <= LEGACY_THRESHOLD_MV) return 0;
		const y = LEGACY_C1 * Math.exp(LEGACY_C2 * mV) + LEGACY_C3;
		return y < 0 ? 0 : y;
	}
	/**
	* ADC 生値を圧力 [N] に換算する。
	* 係数があればそれを使い、null やプレースホルダなら旧式へフォールバックする。
	*/
	function pressureToNewton(adcRaw, calibration) {
		if (calibration && !isPressureCalibrationPlaceholder(calibration)) return applyPressureCalibration(calibration, adcRaw);
		return legacyPressureToNewton(adcRaw);
	}
	//#endregion
	//#region src/protocol/datetime.ts
	/**
	* DATE_TIME characteristic の共通プロトコル。
	*
	* ワイヤ形式は [YY(西暦-2000), MM(1-12), DD, hh, mm, ss, subsec(10ms単位)] の
	* 7 バイト（CORE / INSOLE 共通）。
	* 時刻同期の手続き（読み出し・書き込み・往復時間の補正）は device/time-sync.ts。
	*/
	/** Date → 7 バイトのワイヤ形式 */
	function encodeDateTime(date) {
		return Uint8Array.from([
			date.getFullYear() - 2e3,
			date.getMonth() + 1,
			date.getDate(),
			date.getHours(),
			date.getMinutes(),
			date.getSeconds(),
			Math.floor(date.getMilliseconds() / 10)
		]);
	}
	/** 7 バイトのワイヤ形式 → Date（encodeDateTime の逆変換） */
	function decodeDateTime(data) {
		return new Date(data.getUint8(0) + 2e3, data.getUint8(1) - 1, data.getUint8(2), data.getUint8(3), data.getUint8(4), data.getUint8(5), data.getUint8(6) * 10);
	}
	//#endregion
	//#region src/device/time-sync.ts
	/** デバイスの時刻を読み、往復時間を添えて返す */
	async function readDateTime(transport, options = {}) {
		const clock = options.clock ?? (() => performance.now());
		const uuid = options.uuid ?? "DATE_TIME";
		const start = clock();
		const data = await transport.read(uuid);
		const round_trip_time = Math.floor(clock() - start);
		return {
			date: decodeDateTime(data),
			raw: data,
			round_trip_time
		};
	}
	/** Date をワイヤ形式でデバイスへ書き込む */
	async function writeDateTime(transport, date, options = {}) {
		await transport.write(options.uuid ?? "DATE_TIME", encodeDateTime(date));
	}
	/**
	* デバイスの時計を PC 時刻 + 平均往復時間/2 に同期する。
	*/
	async function syncDeviceTime(transport, options = {}) {
		const samples = options.samples ?? 3;
		const now = options.now ?? (() => /* @__PURE__ */ new Date());
		let sum_round_trip_time = 0;
		const round_trip_times = [];
		for (let i = 0; i < samples; i++) {
			const deviceTime = await readDateTime(transport, options);
			sum_round_trip_time += deviceTime.round_trip_time;
			round_trip_times.push(deviceTime.round_trip_time);
		}
		const average_round_trip_time = sum_round_trip_time / samples;
		const half_round_trip_time = Math.round(average_round_trip_time / 2);
		const standard_time = now().getTime();
		const adjusted_time = standard_time + half_round_trip_time;
		await writeDateTime(transport, new Date(adjusted_time), options);
		return {
			sum_round_trip_time,
			average_round_trip_time,
			standard_time,
			adjusted_time,
			round_trip_times,
			half_round_trip_time
		};
	}
	//#endregion
	//#region src/protocol/geometry.ts
	/** |q|=1 を仮定した Euler 角変換。ジンバルロックは pitch を ±π/2 にクランプ */
	function quatToEuler(q) {
		const w = q.w;
		const x = q.x;
		const y = q.y;
		const z = q.z;
		const t = 2 * (w * y - z * x);
		return {
			roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
			pitch: t >= 1 ? Math.PI / 2 : t <= -1 ? -Math.PI / 2 : Math.asin(t),
			yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
		};
	}
	var CORE_NORMALIZE_EPSILON = 1e-16;
	/**
	* CORE 系の正規化（header 40 の euler 計算用）。
	* ノルムは Math.sqrt(w*w + x*x + y*y + z*z)、EPSILON 未満はゼロ quat。
	* 除算ではなく逆数（1/norm）の乗算で正規化する: 除算とは丸めが異なり、
	* 配送値が変わるため演算を変えないこと。
	*/
	function normalizeQuaternionCoreStyle(q) {
		const w = q.w;
		const x = q.x;
		const y = q.y;
		const z = q.z;
		let norm = Math.sqrt(w * w + x * x + y * y + z * z);
		if (norm < CORE_NORMALIZE_EPSILON) return {
			w: 0,
			x: 0,
			y: 0,
			z: 0
		};
		norm = 1 / norm;
		return {
			w: w * norm,
			x: x * norm,
			y: y * norm,
			z: z * norm
		};
	}
	/**
	* INSOLE 系の正規化。
	* ノルムは Math.hypot（sqrt とは丸めが異なる）、非有限・Number.EPSILON 以下はゼロ quat。
	*/
	function normalizeQuaternionInsoleStyle(q) {
		const norm = Math.hypot(q.w, q.x, q.y, q.z);
		if (!Number.isFinite(norm) || norm <= Number.EPSILON) return {
			w: 0,
			x: 0,
			y: 0,
			z: 0
		};
		return {
			w: q.w / norm,
			x: q.x / norm,
			y: q.y / norm,
			z: q.z / norm
		};
	}
	//#endregion
	//#region src/protocol/imu-range.ts
	/**
	* 加速度・角速度のレンジ設定（device information の index 0..3）と物理値の対応。
	*/
	/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
	var ACC_RANGES = Object.freeze([
		2,
		4,
		8,
		16
	]);
	/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
	var GYRO_RANGES = Object.freeze([
		250,
		500,
		1e3,
		2e3
	]);
	/** レンジ設定を取得できないときのジャイロレンジ [dps] */
	var DEFAULT_GYRO_RANGE = 2e3;
	/** フルスケール 1 dps あたりの感度 [dps/LSB]（LSM6DSOX 代表値。±2000dps → 70 mdps/LSB） */
	var GYRO_DPS_PER_LSB_PER_RANGE = 35e-6;
	function rangeFromSetting(ranges, setting, fallback) {
		return typeof setting === "number" && Number.isInteger(setting) && setting >= 0 && setting < ranges.length ? ranges[setting] : fallback;
	}
	/** device information のレンジ設定（index）→ 物理値。未取得・範囲外は ±16G / ±2000dps。 */
	function imuRangeFromSettings(range) {
		return {
			acc: rangeFromSetting(ACC_RANGES, range?.acc, 16),
			gyro: rangeFromSetting(GYRO_RANGES, range?.gyro, DEFAULT_GYRO_RANGE)
		};
	}
	/** ジャイロの int16 生値 → dps。`gyroRange` はフルスケール [dps]。 */
	function gyroRawToDps(raw, gyroRange) {
		return raw * gyroRange * GYRO_DPS_PER_LSB_PER_RANGE;
	}
	//#endregion
	//#region src/profiles/insole.ts
	/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
	var INSOLE_ACC_RANGES = ACC_RANGES;
	/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
	var INSOLE_GYRO_RANGES = GYRO_RANGES;
	/** フルスケール 1 dps あたりの感度 [dps/LSB]（例: ±2000dps → 0.07） */
	var INSOLE_GYRO_DPS_PER_LSB_PER_RANGE = GYRO_DPS_PER_LSB_PER_RANGE;
	/**
	* ORPHE INSOLE 用の chooser フィルタ。
	* 一部の INSOLE firmware は advertisement に service UUID を載せないため、
	* chooser では INS の namePrefix で候補を絞り、optionalServices で
	* 接続後に必要な service へアクセスする。service UUID を advertise する
	* FW は名前に依らず出せるよう OR フィルタも併記する。
	* 'device_information' は標準 BLE DIS (0x180A)。FW が実装している場合に
	* Firmware Revision の読み出しに使う。
	*/
	function insoleRequestDeviceOptions() {
		return {
			filters: [{ namePrefix: "INS" }, { services: [ORPHE_UUID.INFORMATION_SERVICE] }],
			acceptAllDevices: false,
			optionalServices: [
				ORPHE_UUID.INFORMATION_SERVICE,
				ORPHE_UUID.OTHER_SERVICE,
				"device_information"
			],
			optionalManufacturerData: [0]
		};
	}
	function timestampToday$1(now, hours, minutes, seconds, milliseconds) {
		const date = new Date(now.getTime());
		date.setHours(hours);
		date.setMinutes(minutes);
		date.setSeconds(seconds);
		date.setMilliseconds(milliseconds);
		return date.getTime();
	}
	/**
	* ORPHE INSOLE SENSOR_VALUES packet parser。
	* - header 50 (0x32): quat+gyro+acc ×4（mode 1）
	* - header 55 (0x37): gyro+acc+press ×4（mode 3）
	* - header 54 (0x36): FIFO データパケット（55 と同一レイアウト）
	* - header 56 (0x38): quat+gyro+acc+press ×2（mode 4）
	* 104 バイト以外は null。未知ヘッダは空サンプルでヘッダ情報のみ返す。
	*/
	function parseInsoleSensorValues(data, options = {}) {
		if (!data || typeof data.getUint8 !== "function") throw new TypeError("parseInsoleSensorValues expects a DataView");
		if (data.byteLength !== 104) return null;
		const header = data.getUint8(0);
		const serial_number = data.getUint16(1);
		const gyroRange = Number.isFinite(Number(options.gyroRange)) ? Number(options.gyroRange) : DEFAULT_GYRO_RANGE;
		const accRange = Number.isFinite(Number(options.accRange)) ? Number(options.accRange) : 16;
		const gyroDpsPerLsb = gyroRange * INSOLE_GYRO_DPS_PER_LSB_PER_RANGE;
		const t_start = timestampToday$1(options.now ? options.now() : /* @__PURE__ */ new Date(), data.getUint8(3), data.getUint8(4), data.getUint8(5), data.getUint16(6));
		const samples = [];
		const quatScale = 16384;
		function vector3(x, y, z, timestamp, packet_number) {
			return {
				x: data.getInt16(x) / 32768,
				y: data.getInt16(y) / 32768,
				z: data.getInt16(z) / 32768,
				timestamp,
				serial_number,
				packet_number
			};
		}
		function quat(w, x, y, z, timestamp, packet_number) {
			return {
				w: data.getInt16(w) / quatScale,
				x: data.getInt16(x) / quatScale,
				y: data.getInt16(y) / quatScale,
				z: data.getInt16(z) / quatScale,
				timestamp,
				serial_number,
				packet_number
			};
		}
		function withConverted(sample) {
			const gyro = sample.gyro;
			if (gyro) sample.converted_gyro = {
				x: gyro.x * 32768 * gyroDpsPerLsb,
				y: gyro.y * 32768 * gyroDpsPerLsb,
				z: gyro.z * 32768 * gyroDpsPerLsb,
				timestamp: gyro.timestamp,
				serial_number,
				packet_number: gyro.packet_number
			};
			const acc = sample.acc;
			if (acc) sample.converted_acc = {
				x: acc.x * accRange,
				y: acc.y * accRange,
				z: acc.z * accRange,
				timestamp: acc.timestamp,
				serial_number,
				packet_number: acc.packet_number
			};
			return sample;
		}
		if (header === 50) {
			let timestamp = t_start;
			for (let i = 3; i >= 0; i--) {
				if (i !== 3) timestamp += data.getUint8(28 + 21 * i);
				samples.push(withConverted({
					timestamp,
					serial_number,
					packet_number: 3 - i,
					quat: quat(8 + 21 * i, 10 + 21 * i, 12 + 21 * i, 14 + 21 * i, timestamp, 3 - i),
					gyro: vector3(16 + 21 * i, 18 + 21 * i, 20 + 21 * i, timestamp, 3 - i),
					acc: vector3(22 + 21 * i, 24 + 21 * i, 26 + 21 * i, timestamp, 3 - i)
				}));
			}
		} else if (header === 55 || header === 54) {
			const offset = 24;
			for (let i = 3; i >= 0; i--) {
				const timestamp = t_start;
				const packet_number = 3 - i;
				samples.push(withConverted({
					timestamp,
					serial_number,
					packet_number,
					gyro: vector3(8 + offset * i, 10 + offset * i, 12 + offset * i, timestamp, packet_number),
					acc: vector3(14 + offset * i, 16 + offset * i, 18 + offset * i, timestamp, packet_number),
					press: {
						values: [
							data.getUint16(20 + offset * i),
							data.getUint16(22 + offset * i),
							data.getUint16(24 + offset * i),
							data.getUint16(26 + offset * i),
							data.getUint16(28 + offset * i),
							data.getUint16(30 + offset * i)
						],
						timestamp,
						serial_number,
						packet_number
					}
				}));
			}
		} else if (header === 56) {
			const offset = 32;
			for (let i = 1; i >= 0; i--) {
				const timestamp = t_start;
				const packet_number = 1 - i;
				samples.push(withConverted({
					timestamp,
					serial_number,
					packet_number,
					quat: quat(8 + offset * i, 10 + offset * i, 12 + offset * i, 14 + offset * i, timestamp, packet_number),
					gyro: vector3(16 + offset * i, 18 + offset * i, 20 + offset * i, timestamp, packet_number),
					acc: vector3(22 + offset * i, 24 + offset * i, 26 + offset * i, timestamp, packet_number),
					press: {
						values: [
							data.getUint16(28 + offset * i),
							data.getUint16(30 + offset * i),
							data.getUint16(32 + offset * i),
							data.getUint16(34 + offset * i),
							data.getUint16(36 + offset * i),
							data.getUint16(38 + offset * i)
						],
						timestamp,
						serial_number,
						packet_number
					}
				}));
			}
		} else return {
			header,
			serial_number,
			timestamp: t_start,
			samples: []
		};
		return {
			header,
			serial_number,
			timestamp: t_start,
			samples
		};
	}
	/** DEVICE_INFORMATION の read ペイロードをデコードする */
	function decodeInsoleDeviceInformation(data) {
		return {
			battery: data.getUint8(0),
			mount_position: data.getUint8(1),
			range: {
				acc: data.getUint8(8),
				gyro: data.getUint8(9)
			},
			raw: data
		};
	}
	/** InsoleProfile と GATT 操作から {@link InsoleCommands} を作る */
	function insoleCommands(profile, io) {
		return {
			async readDeviceInformation() {
				profile.device_information = decodeInsoleDeviceInformation(await io.read("DEVICE_INFORMATION"));
				return profile.device_information;
			},
			setDataStreamingMode(mode) {
				return profile.setDataStreamingMode(io, mode);
			},
			resetAnalysisLogs() {
				return io.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ANALYSIS_LOGS]);
			}
		};
	}
	/** 係数取得の間に使う配信モード（圧力を含むモードでないと FW が応答しない） */
	var PRESSURE_CALIBRATION_FETCH_MODE = 4;
	var InsoleProfile = class {
		kind = "insole";
		defaultNotificationType = "SENSOR_VALUES";
		/** begin() で取得したデバイス設定。parse() の換算レンジに使う */
		device_information = null;
		/** 最後に設定した streaming mode */
		streaming_mode = null;
		/**
		* begin() で取得した個体別圧力校正係数（index = センサー番号 0..5）。
		* 旧 FW・未取得は null。FW に値が書かれていない ch はプレースホルダとして null になり、
		* その ch だけ固定式で換算する。
		*/
		pressure_calibrations = null;
		/** 校正係数の応答待ち（センサー番号 → resolve） */
		pendingCalibration = /* @__PURE__ */ new Map();
		defaults;
		serialInitialized = false;
		serialNumber = 0;
		constructor(options = {}) {
			this.defaults = options;
		}
		storageKey(id) {
			return `orphe_insole_last_bluetooth_device_${id}`;
		}
		requestDeviceOptions() {
			return insoleRequestDeviceOptions();
		}
		characteristics() {
			return orpheCharacteristics();
		}
		modes() {
			return INSOLE_MODES.map((mode) => ({ ...mode }));
		}
		/** アドバタイズを `status` フィールドに解釈する */
		parseAdvertisement(event) {
			const status = decodeInsoleAdvertisement(event);
			return status ? { status } : null;
		}
		/** デバイスコマンド（ストリーミングモード切替など）。通常は `ble.commands` から使う */
		commands(io) {
			return insoleCommands(this, io);
		}
		async begin(context) {
			const { transport, options } = context;
			const mode = Number(options.streamingMode ?? options.dataStreamingMode ?? this.defaults.streamingMode ?? 4);
			if (!Number.isInteger(mode) || !INSOLE_STREAMING_MODES[mode]) throw new TransportError("INVALID_MODE", `Invalid ORPHE INSOLE data streaming mode: ${mode}. Use 1, 3, or 4.`);
			const infoData = await transport.read("DEVICE_INFORMATION", options);
			this.device_information = decodeInsoleDeviceInformation(infoData);
			this.pressure_calibrations = null;
			const log = context.log ?? (() => {});
			if (this.shouldFetchPressureCalibration(context.firmware, log)) {
				const fetchMode = INSOLE_STREAMING_MODES[mode].fields.press ? mode : PRESSURE_CALIBRATION_FETCH_MODE;
				await this.setDataStreamingMode(transport, fetchMode);
				await transport.startNotify("SENSOR_VALUES", options);
				this.pressure_calibrations = await this.fetchPressureCalibrations(transport, options, log);
				if (fetchMode !== mode) await this.setDataStreamingMode(transport, mode);
				await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });
				return "done begin(); SENSOR VALUES";
			}
			await this.setDataStreamingMode(transport, mode);
			await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });
			await transport.startNotify("SENSOR_VALUES", options);
			return "done begin(); SENSOR VALUES";
		}
		/** 校正係数の取得設定（オプション省略時は既定値で埋めたもの） */
		pressureCalibrationSettings() {
			const settings = this.defaults.pressureCalibration ?? {};
			return {
				fetch: settings.fetch ?? true,
				timeoutMs: settings.timeoutMs ?? 1e3,
				retries: settings.retries ?? 3
			};
		}
		/**
		* 対応 FW（リリース日がしきい値以上）かつ取得が有効なら true。FW 不明は旧 FW 扱い。
		* 取得しない理由はここでログに出す
		*/
		shouldFetchPressureCalibration(firmware, log) {
			if (!this.pressureCalibrationSettings().fetch) {
				log("圧力校正: 取得無効（pressureCalibration.fetch = false）。固定式で換算");
				return false;
			}
			if (!firmware) {
				log("圧力校正: FW 不明のため取得しません。固定式で換算");
				return false;
			}
			const threshold = INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE;
			if (firmware.releaseDate < threshold) {
				log(`圧力校正: 非対応 FW（リリース日 ${firmware.releaseDate} < ${threshold}）。固定式で換算`);
				return false;
			}
			log(`圧力校正: 対応 FW（リリース日 ${firmware.releaseDate}）。係数を取得します`);
			return true;
		}
		/**
		* 6ch ぶんの校正係数を 1ch ずつ取得し、ch ごとの結果と集計をログに出す。
		* 無応答は試行回数まで再送し、使い切った ch は固定式で換算する（begin() は止めない）。
		* FW に値が書かれていない ch（プレースホルダ）も固定式にする。
		*/
		async fetchPressureCalibrations(transport, options, log) {
			const { timeoutMs, retries } = this.pressureCalibrationSettings();
			const result = [];
			let calibrated = 0;
			let placeholder = 0;
			let missing = 0;
			for (let sensorIndex = 0; sensorIndex < 6; sensorIndex++) {
				let received = null;
				for (let attempt = 0; attempt < retries && !received; attempt++) received = await this.requestPressureCalibration(transport, sensorIndex, timeoutMs, options);
				if (!received) {
					missing++;
					log(`圧力校正 ch${sensorIndex}: 応答なし（${retries} 回）。固定式で換算`);
					result.push(null);
				} else if (isPressureCalibrationPlaceholder(received)) {
					placeholder++;
					log(`圧力校正 ch${sensorIndex}: 未書込（func 0・係数すべて 1.0）。固定式で換算`, received);
					result.push(null);
				} else {
					calibrated++;
					log(`圧力校正 ch${sensorIndex}: 個体別係数`, received);
					result.push(received);
				}
			}
			log(`圧力校正: 個体別係数 ${calibrated}ch / 未書込 ${placeholder}ch / 応答なし ${missing}ch`);
			return result;
		}
		/** 1ch の校正係数を要求し、応答か timeout まで待つ。無応答は null */
		async requestPressureCalibration(transport, sensorIndex, timeoutMs, options) {
			let timer;
			let resolveWaiter;
			const waiter = new Promise((resolve) => {
				resolveWaiter = resolve;
				this.pendingCalibration.set(sensorIndex, resolve);
				timer = setTimeout(() => {
					if (this.pendingCalibration.get(sensorIndex) === resolve) this.pendingCalibration.delete(sensorIndex);
					resolve(null);
				}, timeoutMs);
			});
			try {
				await transport.write("DEVICE_INFORMATION", encodePressureCalibrationRequest(sensorIndex), options);
			} catch {
				if (this.pendingCalibration.get(sensorIndex) === resolveWaiter) this.pendingCalibration.delete(sensorIndex);
				clearTimeout(timer);
				return null;
			}
			const calibration = await waiter;
			clearTimeout(timer);
			return calibration;
		}
		/** SENSOR_VALUES に混ざって届く校正係数の応答を待ち受けへ渡す */
		receivePressureCalibration(data) {
			const decoded = decodePressureCalibration(data);
			if (!decoded) return;
			const resolve = this.pendingCalibration.get(decoded.sensorIndex);
			if (!resolve) return;
			this.pendingCalibration.delete(decoded.sensorIndex);
			resolve(decoded.calibration);
		}
		/** press（ADC 生値）を N に換算した InsolePress を作る */
		toConvertedPress(press) {
			const calibrations = this.pressure_calibrations;
			return {
				...press,
				values: press.values.map((raw, i) => pressureToNewton(raw, calibrations ? calibrations[i] : null))
			};
		}
		/** streaming mode（1/3/4）を書き込む。接続中の切替にも使える */
		async setDataStreamingMode(transport, mode) {
			const normalizedMode = Number(mode);
			if (!Number.isInteger(normalizedMode) || !INSOLE_STREAMING_MODES[normalizedMode]) throw new TransportError("INVALID_MODE", `Invalid ORPHE INSOLE data streaming mode: ${mode}. Use 1, 3, or 4.`);
			await transport.write("DEVICE_INFORMATION", Uint8Array.from([DEVICE_INFORMATION_OPCODE.SET_STREAMING_MODE, normalizedMode]));
			this.streaming_mode = normalizedMode;
		}
		parse(uuid, data) {
			if (uuid !== "SENSOR_VALUES") return null;
			if (isPressureCalibrationPacket(data)) {
				this.receivePressureCalibration(data);
				return null;
			}
			const packet = parseInsoleSensorValues(data, this.sensorParseOptions());
			if (!packet) return null;
			const out = [];
			const loss = this.checkSerialGap(packet.serial_number);
			if (loss) out.push({ lost_data: loss });
			if (packet.header !== 54) for (const sample of packet.samples) out.push(this.toDispatchSample(packet.header, sample));
			return out.length > 0 ? out : null;
		}
		/**
		* 配送順にフィールドを並べ替え、euler を挿入する。
		*   header 50: acc → quat → gyro → converted_acc → converted_gyro → euler
		*   header 55: acc → gyro → converted_acc → converted_gyro → press
		*   header 56: quat → euler → acc → gyro → converted_acc → converted_gyro → press
		* euler は正規化（INSOLE 方式）済み quat から計算する。
		*/
		toDispatchSample(header, sample) {
			const euler = sample.quat ? quatToEuler(normalizeQuaternionInsoleStyle(sample.quat)) : void 0;
			const out = {};
			if (header === 56) {
				out.quat = sample.quat;
				out.euler = euler;
			}
			out.acc = sample.acc;
			if (header === 50) out.quat = sample.quat;
			out.gyro = sample.gyro;
			out.converted_acc = sample.converted_acc;
			out.converted_gyro = sample.converted_gyro;
			if (header === 50) out.euler = euler;
			if (header !== 50) out.press = sample.press;
			if (header !== 50 && sample.press) out.converted_press = this.toConvertedPress(sample.press);
			out.timestamp = sample.timestamp;
			out.serial_number = sample.serial_number;
			out.packet_number = sample.packet_number;
			return out;
		}
		checkSerialGap(current) {
			if (!this.serialInitialized) {
				this.serialInitialized = true;
				this.serialNumber = current;
				return null;
			}
			const prev = this.serialNumber;
			this.serialNumber = current;
			return (current - prev + 65536) % 65536 !== 1 ? {
				serial: current,
				prev
			} : null;
		}
		/**
		* 取得済みレンジ設定 index → パーサーのフルスケール値（未取得は 16G/2000dps）
		*
		* @internal
		*/
		sensorParseOptions() {
			const { acc, gyro } = imuRangeFromSettings(this.device_information?.range);
			return {
				accRange: acc,
				gyroRange: gyro
			};
		}
	};
	/** ORPHE INSOLE 用の DeviceProfile を生成する */
	function insoleProfile(options = {}) {
		return new InsoleProfile(options);
	}
	//#endregion
	//#region src/ble/device-memory.ts
	/** 記憶デバイスの在圏確認で広告を待つ既定時間 [ms] */
	var DEFAULT_ADVERTISEMENT_TIMEOUT_MS = 2e3;
	/**
	* 接続に成功したデバイスを storage へ記憶し、次回は chooser なしで復元する。
	* storage 例外や getDevices() 未対応は「記憶なし」として静かに扱う。
	*/
	var DeviceMemory = class {
		storageKey;
		storage;
		/** 復元を試みたが接続に失敗した場合に立てる（次回は chooser へフォールバック） */
		unavailable = false;
		/** 直近の在圏確認で広告を受信するまでにかかった時間 [ms]（診断用） */
		lastAdvertisementWaitMs = null;
		constructor(storageKey, storage) {
			this.storageKey = storageKey;
			this.storage = storage;
		}
		/** 接続に成功したデバイスを記憶する（storage が使えなければ何もしない）。 */
		remember(device) {
			if (!device) return;
			this.unavailable = false;
			try {
				const info = {
					bluetoothId: device.id || "",
					bluetoothName: device.name || "",
					lastConnectedAt: Date.now()
				};
				this.storage.setItem(this.storageKey, JSON.stringify(info));
			} catch {}
		}
		/** 記憶しているデバイス情報を読む。無効・不在なら null。 */
		load() {
			try {
				const raw = this.storage.getItem(this.storageKey);
				if (!raw) return null;
				const info = JSON.parse(raw);
				if (!info || !info.bluetoothId && !info.bluetoothName) return null;
				return {
					bluetoothId: info.bluetoothId || "",
					bluetoothName: info.bluetoothName || "",
					lastConnectedAt: Number(info.lastConnectedAt) || 0
				};
			} catch {
				return null;
			}
		}
		/** 記憶を消す（次回は必ず chooser を出す）。 */
		forget() {
			this.unavailable = false;
			try {
				this.storage.removeItem(this.storageKey);
			} catch {}
		}
		/** 復元を試みて失敗したことを記録し、以降は chooser へフォールバックさせる。 */
		markUnavailable() {
			this.unavailable = true;
		}
		/** 記憶があり、かつ前回の復元が失敗マークされていないか */
		shouldTryRestore() {
			return !this.unavailable && this.load() !== null;
		}
		/**
		* getDevices() の一覧から記憶デバイスを探し、在圏を確かめてから返す。
		* id 完全一致 → 名前の一意一致 の順。見つからない・圏外なら null。
		*/
		async restore(bluetooth, options = {}) {
			if (typeof bluetooth.getDevices !== "function") return null;
			const info = this.load();
			if (!info) return null;
			try {
				const devices = await bluetooth.getDevices();
				const device = this.find(devices, info);
				if (!device) return null;
				const timeoutMs = options.advertisementTimeoutMs ?? DEFAULT_ADVERTISEMENT_TIMEOUT_MS;
				return await this.isReachable(device, timeoutMs) ? device : null;
			} catch {
				return null;
			}
		}
		/**
		* 広告を受信できるか（＝電波の届く範囲にいるか）を確かめる。
		*
		* getDevices() が返すのは「権限を与えたことがあるデバイス」であって在圏は保証しない。
		* ここを省いて直接 gatt.connect() すると、圏外のデバイスに対して
		* 「Bluetooth Device is no longer in range.」で失敗し、chooser への
		* フォールバックが次回接続まで持ち越されてしまう（接続ボタンを2回押す羽目になる）。
		*
		* 判定できない環境（watchAdvertisements 未対応・呼び出し自体が失敗）では true を返し、
		* そのまま接続を試みる。
		*/
		isReachable(device, timeoutMs) {
			if (device.gatt?.connected) return Promise.resolve(true);
			if (typeof device.watchAdvertisements !== "function") return Promise.resolve(true);
			return new Promise((resolve) => {
				let settled = false;
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				const finish = (reachable) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					device.removeEventListener("advertisementreceived", onAdvertisement);
					try {
						controller?.abort();
					} catch {}
					resolve(reachable);
				};
				const startedAt = Date.now();
				const onAdvertisement = () => {
					this.lastAdvertisementWaitMs = Date.now() - startedAt;
					finish(true);
				};
				const timer = setTimeout(() => finish(false), timeoutMs);
				device.addEventListener("advertisementreceived", onAdvertisement);
				Promise.resolve(device.watchAdvertisements(controller ? { signal: controller.signal } : void 0)).catch(() => finish(true));
			});
		}
		find(devices, info) {
			if (!Array.isArray(devices)) return null;
			if (info.bluetoothId) {
				const matchedById = devices.find((device) => device.id === info.bluetoothId);
				if (matchedById) return matchedById;
			}
			if (info.bluetoothName) {
				const matchedByName = devices.filter((device) => device.name === info.bluetoothName);
				if (matchedByName.length === 1) return matchedByName[0];
			}
			return null;
		}
	};
	//#endregion
	//#region src/ble/gatt-queue.ts
	/**
	* 全GATT操作のグローバル直列化キュー。
	*
	* Web Bluetooth の GATT 操作（read/write/startNotifications/stopNotifications）は
	* プラットフォームによって並行発行に耐えられないため、1本のチェーンで直列化する。
	*/
	var GattOperationQueue = class {
		tail = Promise.resolve();
		/**
		* 操作をキューへ投入する。
		* 先行操作の完了（成功/失敗を問わず）後に実行され、
		* この操作自身の結果/例外だけが返る Promise を返す。
		*/
		enqueue(operation) {
			const run = this.tail.catch(() => {}).then(operation);
			this.tail = run.catch(() => {});
			return run;
		}
	};
	//#endregion
	//#region src/ble/transport.ts
	var DEFAULT_RECONNECT_INTERVAL_MS = 3e3;
	var DEFAULT_RECONNECT_MAX_ATTEMPTS = 120;
	/**
	* Web Bluetooth を包む BLE トランスポート。
	*
	* デバイス選択（chooser / 記憶デバイス復元）、GATT 接続、read / write /
	* notify の直列実行、自動再接続をここに集約する。パケットの意味づけは
	* 一切持たず、デバイス固有の処理は {@link DeviceProfile} 側の責務。
	*/
	var OrpheBleTransport = class {
		config;
		events;
		bluetooth;
		memory;
		queue = new GattOperationQueue();
		registry = {};
		currentDevice = null;
		usingRememberedDevice = false;
		characteristics = {};
		connecting = false;
		notifyTokens = {};
		notifyHandlers = {};
		notifyCharacteristics = {};
		reconnectEnabled = false;
		reconnectInProgress = false;
		reconnectArmed = false;
		reconnectOptions = {};
		suppressErrors = false;
		afterReconnectSuccessHooks = [];
		disconnectHooks = [];
		/** 遅延バインド切断ハンドラ。デバイスごとに1回だけ登録する */
		disconnectHandler = (event) => {
			this.invalidateNotifyOperations();
			for (const hook of [...this.disconnectHooks]) try {
				hook(event);
			} catch (error) {
				this.safeReportError(error);
			}
			this.fireEvent("onDisconnect", event);
			this.maybeStartReconnect();
		};
		constructor(config) {
			this.config = config;
			this.events = config.events ?? {};
			this.bluetooth = config.bluetooth ?? (typeof navigator !== "undefined" ? navigator.bluetooth ?? null : null);
			const storage = config.storage ?? (typeof localStorage !== "undefined" ? localStorage : new InMemoryFallbackStorage());
			this.memory = new DeviceMemory(config.storageKey ?? "orphe_ble_last_device", storage);
			for (const [name, id] of Object.entries(config.characteristics ?? {})) this.registerCharacteristic(name, id);
			if (config.reconnect) this.reconnectOptions = { ...config.reconnect };
		}
		/** 論理名 → UUID ペアを登録する（config.characteristics への後追い追加）。 */
		registerCharacteristic(name, id) {
			this.registry[name] = { ...id };
		}
		/** その論理名が登録済みか（プロファイルが宣言していない characteristic の判定）。 */
		hasCharacteristic(name) {
			return Object.prototype.hasOwnProperty.call(this.registry, name);
		}
		/** 現在割り当てられているデバイス。未選択なら null。 */
		get device() {
			return this.currentDevice;
		}
		/** GATT 接続中なら true。 */
		isConnected() {
			return !!this.currentDevice?.gatt?.connected;
		}
		/** 接続状態。`reconnecting` は自動再接続の試行中。 */
		get connectionState() {
			if (this.isConnected()) return "connected";
			if (this.reconnectInProgress) return "reconnecting";
			if (this.connecting) return "connecting";
			return "disconnected";
		}
		/** デバイスSDK層の begin() が接続処理中フラグを立てるための口 */
		setConnecting(flag) {
			this.connecting = flag;
		}
		/**
		* デバイスを確保する。選択済みなら何もしない。
		* 記憶デバイスがあれば chooser なしで復元し、なければ chooser を開く。
		*/
		scan(uuid, options = {}) {
			if (this.currentDevice) {
				if (options.forceDeviceSelection) {
					this.reconnectArmed = false;
					this.dropCurrentDevice({ disconnect: true });
				} else return Promise.resolve();
			}
			this.log("scan()", {
				uuid,
				options
			});
			const tryRestore = !options.forceDeviceSelection && this.memory.shouldTryRestore();
			return (async () => {
				const bluetooth = this.requireBluetooth();
				const restored = tryRestore ? await this.memory.restore(bluetooth) : null;
				if (!restored) {
					await this.requestDevice(options);
					return;
				}
				const reason = this.config.deviceGuard?.(restored) ?? null;
				if (reason) {
					this.memory.forget();
					if (this.reconnectInProgress) throw new TransportError("DEVICE_DISALLOWED", reason);
					await this.requestDevice(options);
					return;
				}
				this.log("scan() 記憶デバイスを復元", {
					id: restored.id,
					name: restored.name
				});
				this.adoptDevice(restored, { remembered: true });
			})().catch((error) => {
				if (!options.silent) this.reportError(error);
				throw error;
			});
		}
		/** chooser を開いてデバイスを選択する（記憶は使わない） */
		async requestDevice(_options = {}) {
			const bluetooth = this.requireBluetooth();
			const configured = this.config.requestDeviceOptions;
			const requestDeviceOptions = typeof configured === "function" ? configured() : configured;
			this.log("requestDevice()", { requestDeviceOptions });
			const device = await bluetooth.requestDevice(requestDeviceOptions);
			this.log("requestDevice() selected", {
				id: device.id,
				name: device.name
			});
			const reason = this.config.deviceGuard?.(device) ?? null;
			if (reason) throw new TransportError("DEVICE_DISALLOWED", reason);
			this.adoptDevice(device, { remembered: false });
		}
		/**
		* 記憶を破棄して必ず chooser を開く。
		* 接続済みデバイスから別デバイスへ手動で切り替える場合に使う。
		*/
		selectDevice() {
			this.disableAutoReconnect();
			this.invalidateNotifyOperations();
			this.forgetRememberedDevice();
			this.dropCurrentDevice({ disconnect: true });
			return this.requestDevice().catch((error) => {
				this.reportError(error);
				throw error;
			});
		}
		/** 現在のデバイスを記憶する（接続成功後にデバイスSDK層が呼ぶ） */
		rememberCurrentDevice() {
			if (this.currentDevice) this.memory.remember(this.currentDevice);
		}
		/** 記憶しているデバイス情報（無ければ null） */
		rememberedDevice() {
			return this.memory.load();
		}
		/** 記憶デバイスを忘れる（次回は必ず chooser を出す）。 */
		forgetRememberedDevice() {
			this.memory.forget();
		}
		adoptDevice(device, { remembered }) {
			this.currentDevice = device;
			this.usingRememberedDevice = remembered;
			device.addEventListener("gattserverdisconnected", this.disconnectHandler);
			this.fireEvent("onScan", device.name);
		}
		dropCurrentDevice({ disconnect }) {
			const device = this.currentDevice;
			if (!device) return;
			if (disconnect && device.gatt?.connected) try {
				device.gatt.disconnect();
			} catch {}
			device.removeEventListener("gattserverdisconnected", this.disconnectHandler);
			this.currentDevice = null;
			this.characteristics = {};
			this.usingRememberedDevice = false;
		}
		/**
		* uuid（論理名）の characteristic を確保する。
		* UUID 別にキャッシュし、GATT リンク切断後はキャッシュを無効化する。
		*/
		connectGATT(uuid, options = {}) {
			const device = this.currentDevice;
			if (!device?.gatt) {
				const error = new TransportError("NO_DEVICE", "No Bluetooth Device");
				if (!options.silent) this.reportError(error);
				return Promise.reject(error);
			}
			const id = this.registry[uuid];
			if (!id) {
				const error = new TransportError("UNKNOWN_UUID", `Unknown characteristic name: ${uuid}`);
				if (!options.silent) this.reportError(error);
				return Promise.reject(error);
			}
			if (device.gatt.connected && this.characteristics[uuid]) return Promise.resolve();
			if (!device.gatt.connected) this.characteristics = {};
			this.log("connectGATT()", {
				uuid,
				serviceUUID: id.serviceUUID,
				linked: device.gatt.connected
			});
			const startedAt = Date.now();
			let connectPromise = device.gatt.connect();
			const timeoutMs = Number(options.connectTimeoutMs ?? this.config.connectTimeoutMs);
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				let timeoutTimer;
				connectPromise = Promise.race([connectPromise.finally(() => clearTimeout(timeoutTimer)), new Promise((_, reject) => {
					timeoutTimer = setTimeout(() => {
						try {
							this.currentDevice?.gatt?.disconnect();
						} catch {}
						reject(new TransportError("CONNECT_TIMEOUT", `GATT connect timed out after ${timeoutMs}ms`));
					}, timeoutMs);
				})]);
			}
			let linkedAt = startedAt;
			return connectPromise.then(() => {
				linkedAt = Date.now();
				return device.gatt.getPrimaryService(id.serviceUUID);
			}).then((service) => service.getCharacteristic(id.characteristicUUID)).then((characteristic) => {
				this.characteristics[uuid] = characteristic;
				this.log("connectGATT() 完了", {
					uuid,
					connectMs: linkedAt - startedAt,
					discoverMs: Date.now() - linkedAt
				});
				this.fireEvent("onConnect", uuid);
			}).catch((error) => {
				this.log("connectGATT() 失敗", {
					uuid,
					message: error instanceof Error ? error.message : String(error)
				});
				if (!options.silent) this.reportError(error);
				if (this.usingRememberedDevice) {
					this.memory.markUnavailable();
					this.dropCurrentDevice({ disconnect: false });
				}
				throw error;
			});
		}
		characteristicFor(uuid) {
			const characteristic = this.characteristics[uuid];
			if (!characteristic) throw new TransportError("UNKNOWN_UUID", `Characteristic not connected: ${uuid}`);
			return characteristic;
		}
		/**
		* characteristic を read する。未接続なら選択・接続まで自動で行う。
		* @param uuid 論理名（`'DEVICE_INFORMATION'` など）
		*/
		read(uuid, options = {}) {
			return this.queue.enqueue(() => this.scan(uuid, options).then(() => this.connectGATT(uuid, options)).then(() => this.characteristicFor(uuid).readValue()).catch((error) => {
				if (!options.silent) this.reportError(error);
				throw error;
			}));
		}
		/**
		* characteristic へ write する。未接続なら選択・接続まで自動で行う。
		* @param uuid 論理名（`'DEVICE_INFORMATION'` など）
		* @param data バイト列（配列でも TypedArray でも可）
		*/
		write(uuid, data, options = {}) {
			return this.queue.enqueue(() => this.scan(uuid, options).then(() => this.connectGATT(uuid, options)).then(() => {
				const bytes = toUint8Array(data);
				return this.characteristicFor(uuid).writeValue(bytes);
			}).then(() => {
				this.fireEvent("onWrite", uuid);
			}).catch((error) => {
				this.reportError(error);
				throw error;
			}));
		}
		/** GATT を切断する。自動再接続が armed なら再接続ループが走る。 */
		disconnect() {
			if (!this.currentDevice?.gatt) {
				this.reportError(new TransportError("NO_DEVICE", "No Bluetooth Device"));
				return;
			}
			if (!this.currentDevice.gatt.connected) {
				this.reportError(new TransportError("ALREADY_DISCONNECTED", "Bluetooth Device is already disconnected"));
				return;
			}
			this.currentDevice.gatt.disconnect();
		}
		/** 切断せずにデバイス割り当てだけ解除する（別スロットへ譲るときなど）。notify 購読も無効化する。 */
		clear() {
			this.invalidateNotifyOperations();
			this.dropCurrentDevice({ disconnect: false });
		}
		/** 切断 + クリア + 自動再接続解除 */
		reset() {
			this.disableAutoReconnect();
			this.invalidateNotifyOperations();
			this.dropCurrentDevice({ disconnect: true });
		}
		/**
		* characteristic の notify を開始する。受信は `events.onNotification` へ流れる。
		* @param uuid 論理名（`'SENSOR_VALUES'` など）
		*/
		startNotify(uuid, options = {}) {
			this.log("startNotify()", { uuid });
			const token = this.nextNotifyToken(uuid);
			return this.queue.enqueue(() => this.scan(uuid, options).then(() => {
				if (this.notifyTokens[uuid] !== token) return void 0;
				return this.connectGATT(uuid, options);
			}).then(async () => {
				if (this.notifyTokens[uuid] !== token) return void 0;
				const characteristic = this.characteristicFor(uuid);
				await characteristic.startNotifications();
				if (this.notifyTokens[uuid] !== token) return void 0;
				const previousHandler = this.notifyHandlers[uuid];
				const previousCharacteristic = this.notifyCharacteristics[uuid];
				if (previousHandler && previousCharacteristic) try {
					previousCharacteristic.removeEventListener("characteristicvaluechanged", previousHandler);
				} catch {}
				const handler = (event) => {
					this.dispatchNotification(uuid, event);
				};
				this.notifyHandlers[uuid] = handler;
				this.notifyCharacteristics[uuid] = characteristic;
				characteristic.addEventListener("characteristicvaluechanged", handler);
				this.fireEvent("onStartNotify", uuid);
			}).catch((error) => {
				this.reportError(error);
				throw error;
			})).then(() => void 0);
		}
		/** characteristic の notify を停止する（CCCD の購読解除のみ）。 */
		stopNotify(uuid, options = {}) {
			const token = this.nextNotifyToken(uuid);
			return this.queue.enqueue(() => this.scan(uuid, options).then(() => {
				if (this.notifyTokens[uuid] !== token) return void 0;
				return this.connectGATT(uuid, options);
			}).then(async () => {
				if (this.notifyTokens[uuid] !== token) return void 0;
				const characteristic = this.characteristicFor(uuid);
				const handler = this.notifyHandlers[uuid];
				const handlerCharacteristic = this.notifyCharacteristics[uuid] || characteristic;
				await characteristic.stopNotifications();
				if (handler) try {
					handlerCharacteristic.removeEventListener("characteristicvaluechanged", handler);
				} catch {}
				if (this.notifyHandlers[uuid] === handler) delete this.notifyHandlers[uuid];
				if (this.notifyCharacteristics[uuid] === handlerCharacteristic) delete this.notifyCharacteristics[uuid];
				if (this.notifyTokens[uuid] === token) this.fireEvent("onStopNotify", uuid);
			}).catch((error) => {
				this.reportError(error);
				throw error;
			})).then(() => void 0);
		}
		nextNotifyToken(uuid) {
			const next = (this.notifyTokens[uuid] || 0) + 1;
			this.notifyTokens[uuid] = next;
			return next;
		}
		/** 通知データの配送。onNotification の throw は他の通知配送を壊さない */
		dispatchNotification(uuid, event) {
			const value = event.target?.value;
			if (!value) return;
			try {
				this.events.onNotification?.(uuid, value);
			} catch (error) {
				this.safeReportError(error);
			}
		}
		invalidateNotifyOperations() {
			const uuids = /* @__PURE__ */ new Set([
				...Object.keys(this.notifyTokens),
				...Object.keys(this.notifyHandlers),
				...Object.keys(this.notifyCharacteristics)
			]);
			for (const uuid of uuids) {
				this.notifyTokens[uuid] = (this.notifyTokens[uuid] || 0) + 1;
				const handler = this.notifyHandlers[uuid];
				const characteristic = this.notifyCharacteristics[uuid];
				if (handler && characteristic) try {
					characteristic.removeEventListener("characteristicvaluechanged", handler);
				} catch {}
				delete this.notifyHandlers[uuid];
				delete this.notifyCharacteristics[uuid];
			}
		}
		/**
		* 自動再接続を有効化する（`config.reconnectConnect` が必要）。
		* 実際にループが走るのは接続成功後に armAutoReconnect() されてから。
		*/
		enableAutoReconnect(options = {}) {
			if (typeof this.config.reconnectConnect !== "function") throw new TransportError("RECONNECT_NOT_CONFIGURED", "config.reconnectConnect is required for auto reconnect");
			this.reconnectEnabled = true;
			this.reconnectOptions = {
				...this.config.reconnect,
				...options
			};
		}
		/** 自動再接続を無効化し、進行中のループも止める。 */
		disableAutoReconnect() {
			this.reconnectEnabled = false;
			this.reconnectArmed = false;
			this.reconnectInProgress = false;
			this.suppressErrors = false;
		}
		/** 接続成功後に呼ぶ。以後の gattserverdisconnected で再接続ループを起動する */
		armAutoReconnect() {
			this.reconnectArmed = true;
		}
		/** 再接続ループを手動起動する（通常は切断イベントから自動起動される） */
		startReconnect() {
			this.runReconnectLoop();
		}
		/**
		* 再接続成功後の内部フックを登録し、解除関数を返す。
		* begin() が再購読する経路以外の characteristic（Gait/FIFO 等）の
		* 再購読に使う。
		*/
		addAfterReconnectSuccessHook(hook) {
			this.afterReconnectSuccessHooks.push(hook);
			return () => {
				const index = this.afterReconnectSuccessHooks.indexOf(hook);
				if (index >= 0) this.afterReconnectSuccessHooks.splice(index, 1);
			};
		}
		/**
		* gattserverdisconnected の内部フックを登録し、解除関数を返す。
		* events.onDisconnect（ユーザ向け）を占有せずに、モジュール（Gait/FIFO 等）が
		* 自身の購読状態を無効化するために使う。ユーザコールバックより先に呼ばれる。
		*/
		addDisconnectHook(hook) {
			this.disconnectHooks.push(hook);
			return () => {
				const index = this.disconnectHooks.indexOf(hook);
				if (index >= 0) this.disconnectHooks.splice(index, 1);
			};
		}
		maybeStartReconnect() {
			if (!this.reconnectEnabled || !this.reconnectArmed || this.reconnectInProgress) return;
			this.runReconnectLoop();
		}
		async runReconnectLoop() {
			if (!this.reconnectEnabled || this.reconnectInProgress) return;
			const connect = this.config.reconnectConnect;
			if (!connect) {
				this.reportError(new TransportError("RECONNECT_NOT_CONFIGURED", "config.reconnectConnect is required for auto reconnect"));
				return;
			}
			this.reconnectInProgress = true;
			const startedAt = Date.now();
			const maxAttempts = this.reconnectMaxAttempts();
			const intervalMs = this.reconnectIntervalMs();
			let lastError = null;
			for (let attempt = 1; this.reconnectEnabled && attempt <= maxAttempts; attempt++) {
				this.fireEvent("onReconnectAttempt", {
					attempt,
					maxAttempts,
					intervalMs
				});
				try {
					if (!await this.restoreDeviceForReconnect()) throw new TransportError("RECONNECT_DEVICE_NOT_FOUND", "Last connected Bluetooth device not found. Please reconnect manually.");
					this.suppressErrors = true;
					const result = await connect();
					this.suppressErrors = false;
					this.reconnectInProgress = false;
					const info = {
						attempt,
						maxAttempts,
						elapsedMs: Date.now() - startedAt,
						result
					};
					for (const hook of this.afterReconnectSuccessHooks.slice()) try {
						const hookResult = hook();
						if (hookResult && typeof hookResult.catch === "function") hookResult.catch((hookError) => this.safeReportError(hookError));
					} catch (hookError) {
						this.safeReportError(hookError);
					}
					this.fireEvent("onReconnectSuccess", info);
					return;
				} catch (error) {
					this.suppressErrors = false;
					lastError = error;
				}
				if (!this.reconnectEnabled || attempt >= maxAttempts) break;
				await this.waitMs(intervalMs);
			}
			this.reconnectInProgress = false;
			const error = lastError ?? new TransportError("RECONNECT_FAILED", "Auto reconnect failed.");
			this.fireEvent("onReconnectFailed", {
				maxAttempts,
				elapsedMs: Date.now() - startedAt,
				error
			});
			this.safeReportError(error);
		}
		/** デバイスを失っている場合、記憶から復元する */
		async restoreDeviceForReconnect() {
			if (this.currentDevice) return true;
			const bluetooth = this.requireBluetooth();
			const restored = await this.memory.restore(bluetooth);
			if (!restored) return false;
			this.adoptDevice(restored, { remembered: true });
			return true;
		}
		reconnectIntervalMs() {
			const interval = Number(this.reconnectOptions.intervalMs);
			return Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_RECONNECT_INTERVAL_MS;
		}
		reconnectMaxAttempts() {
			const attempts = Number(this.reconnectOptions.maxAttempts);
			return Number.isFinite(attempts) && attempts > 0 ? attempts : DEFAULT_RECONNECT_MAX_ATTEMPTS;
		}
		waitMs(ms) {
			return (this.config.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))))(ms);
		}
		requireBluetooth() {
			if (!this.bluetooth) throw new TransportError("NO_BLUETOOTH", "Web Bluetooth API is not available");
			return this.bluetooth;
		}
		/**
		* transport 内エラーの報告。自動再接続の試行中は onError を逐一発火させない
		* （最終失敗のみループが報告する）。
		*/
		reportError(error) {
			if (this.suppressErrors) return;
			this.safeReportError(error);
		}
		/** onError 自体の throw も外へ伝播させない */
		safeReportError(error) {
			try {
				this.events.onError?.(error);
			} catch (reportError) {
				try {
					console.error("OrpheBleTransport onError callback failed:", reportError);
				} catch {}
			}
		}
		/**
		* ライフサイクルイベントの発火。ユーザコールバックの throw は
		* トランスポートの状態遷移を壊さず onError へ報告する。
		*/
		fireEvent(name, ...args) {
			const callback = this.events[name];
			if (typeof callback !== "function") return;
			try {
				const result = callback(...args);
				if (result && typeof result.catch === "function") result.catch((error) => this.safeReportError(error));
			} catch (error) {
				this.safeReportError(error);
			}
		}
		log(message, detail) {
			this.config.log?.(message, detail);
		}
	};
	function toUint8Array(data) {
		if (data instanceof Uint8Array) return data;
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		return Uint8Array.from(data);
	}
	/** localStorage が存在しない環境（テスト以外では通らない想定）用のフォールバック */
	var InMemoryFallbackStorage = class {
		map = /* @__PURE__ */ new Map();
		getItem(key) {
			return this.map.has(key) ? this.map.get(key) : null;
		}
		setItem(key, value) {
			this.map.set(key, value);
		}
		removeItem(key) {
			this.map.delete(key);
		}
	};
	var BUILD_ID_LENGTH = 15;
	/** ASCII 部を読む。非印字文字は終端として扱う */
	function readBuildId(dv) {
		let out = "";
		for (let i = 0; i < BUILD_ID_LENGTH; i++) {
			const code = dv.getUint8(i);
			if (code < 32 || code > 126) break;
			out += String.fromCharCode(code);
		}
		return out;
	}
	function pad(value, width) {
		return String(value).padStart(width, "0");
	}
	/**
	* GET_FW_NAME の read ペイロードをデコードする。
	* 長さ不足や日付が不正な値（未書込・別フォーマット）の場合は null。
	*/
	function decodeFirmwareInfo(data) {
		if (!data || data.byteLength < 23) return null;
		const year = data.getUint16(18);
		const month = data.getUint8(20);
		const day = data.getUint8(21);
		if (year < 2e3 || year > 2199) return null;
		if (month < 1 || month > 12) return null;
		if (day < 1 || day > 31) return null;
		const buildId = readBuildId(data);
		const major = data.getUint8(15);
		const minor = data.getUint16(16);
		const patch = data.getUint8(22);
		const yyyymmdd = `${year}${pad(month, 2)}${pad(day, 2)}`;
		return {
			buildId,
			major,
			minor,
			patch,
			releasedAt: new Date(year, month - 1, day),
			releaseDate: Number(yyyymmdd),
			name: `${buildId}-${major}-${pad(minor, 4)}-${yyyymmdd}-${pad(patch, 2)}`,
			raw: data
		};
	}
	//#endregion
	//#region src/device/sample-emitter.ts
	/**
	* 正規化サンプルをフィールド名ごとのコールバックへ配送する emitter。
	* リスナーの throw は他のリスナーへの配送を壊さない。
	*/
	var SampleEmitter = class {
		listeners = /* @__PURE__ */ new Map();
		onListenerError;
		constructor(onListenerError) {
			this.onListenerError = onListenerError ?? null;
		}
		/**
		* フィールド名（'acc' 等）で購読する。'*' はサンプル全体を受け取る。
		* 解除関数を返す。
		*/
		on(field, listener) {
			let set = this.listeners.get(field);
			if (!set) {
				set = /* @__PURE__ */ new Set();
				this.listeners.set(field, set);
			}
			const stored = listener;
			set.add(stored);
			return () => {
				set.delete(stored);
				if (set.size === 0) this.listeners.delete(field);
			};
		}
		/** そのフィールドの購読者数（`'*'` も 1 つのフィールドとして数える）。 */
		listenerCount(field) {
			return this.listeners.get(field)?.size ?? 0;
		}
		/**
		* サンプル列を購読者へ配送する。`'*'` 購読者にはサンプル全体、
		* フィールド購読者には `undefined` でない値だけを渡す。
		*/
		emit(uuid, samples) {
			for (const sample of samples) {
				const meta = {
					uuid,
					sample
				};
				const record = sample;
				const wildcard = this.listeners.get("*");
				if (wildcard) for (const listener of [...wildcard]) this.safeCall(listener, sample, meta);
				for (const field of Object.keys(record)) {
					const value = record[field];
					if (value === void 0) continue;
					const set = this.listeners.get(field);
					if (!set) continue;
					for (const listener of [...set]) this.safeCall(listener, value, meta);
				}
			}
		}
		safeCall(listener, value, meta) {
			try {
				listener(value, meta);
			} catch (error) {
				if (this.onListenerError) try {
					this.onListenerError(error);
				} catch {}
			}
		}
	};
	//#endregion
	//#region src/modes/core.ts
	/**
	* FIFO 収録に対応した CORE FW の最小リリース日（`YYYYMMDD`）。
	* これより古い FW は FIFO のコマンドに応答しないため、モード候補から外す。
	*/
	var CORE_FIFO_MIN_RELEASE_DATE = 20260905;
	/** CORE の取得モード一覧（FW による絞り込み前） */
	var CORE_MODES = Object.freeze([
		Object.freeze({
			id: "STEP_ANALYSIS_AND_SENSOR_VALUES",
			label: "Step analysis + sensor values",
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "STEP_ANALYSIS",
			label: "Step analysis",
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "SENSOR_VALUES",
			label: "Sensor values",
			minReleaseDate: 0
		}),
		Object.freeze({
			id: "FIFO",
			label: "Lossless FIFO recording",
			minReleaseDate: CORE_FIFO_MIN_RELEASE_DATE
		})
	]);
	//#endregion
	//#region src/protocol/float16.ts
	/**
	* IEEE 754 half-precision (binary16) の読み出し。
	*
	* CORE の STEP_ANALYSIS packet が calorie / quat / delta を float16 で運ぶ。
	* DataView の他の get* と同じく既定は big-endian。
	*/
	function getFloat16(view, byteOffset, littleEndian = false) {
		const bits = view.getUint16(byteOffset, littleEndian);
		const sign = bits & 32768 ? -1 : 1;
		const exponent = bits >> 10 & 31;
		const fraction = bits & 1023;
		if (exponent === 0) return fraction === 0 ? sign * 0 : sign * fraction * 2 ** -24;
		if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
		return sign * (1024 + fraction) * 2 ** (exponent - 25);
	}
	//#endregion
	//#region src/profiles/core.ts
	/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
	var CORE_ACC_RANGES = ACC_RANGES;
	/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
	var CORE_GYRO_RANGES = GYRO_RANGES;
	function timestampToday(now, hours, minutes, seconds, milliseconds) {
		const date = new Date(now.getTime());
		date.setHours(hours);
		date.setMinutes(minutes);
		date.setSeconds(seconds);
		date.setMilliseconds(milliseconds);
		return date.getTime();
	}
	/**
	* SENSOR_VALUES packet parser。
	* - header 50 (0x32): 200Hz・92byte・21byte×4フレーム
	* - header 40 (0x28): 通常・quat Q14・gyro/acc int8/127・単一サンプル
	* 対象外ヘッダ・不正長は null。
	*/
	function parseCoreSensorValues(data, options) {
		const header = data.getUint8(0);
		const { accRange, gyroRange } = options;
		if (header === 50) {
			if (data.byteLength !== 92) return null;
			const serial_number = data.getUint16(1);
			const t_base = timestampToday(options.now ? options.now() : /* @__PURE__ */ new Date(), data.getUint8(3), data.getUint8(4), data.getUint8(5), data.getUint16(6));
			const delta0 = data.getUint8(28);
			const delta1 = data.getUint8(49);
			const delta2 = data.getUint8(70);
			const frameAgeMs = [
				delta0,
				delta1,
				delta2,
				delta2 + (delta1 - delta0)
			];
			const samples = [];
			let previousQuat = options.previousQuat ?? null;
			for (let i = 3; i >= 0; i--) {
				const stamp = {
					timestamp: t_base - frameAgeMs[i],
					serial_number,
					packet_number: 3 - i
				};
				const gyro = {
					x: data.getInt16(16 + 21 * i) / 32768,
					y: data.getInt16(18 + 21 * i) / 32768,
					z: data.getInt16(20 + 21 * i) / 32768,
					...stamp
				};
				const acc = {
					x: data.getInt16(22 + 21 * i) / 32768,
					y: data.getInt16(24 + 21 * i) / 32768,
					z: data.getInt16(26 + 21 * i) / 32768,
					...stamp
				};
				const unit = normalizeFrameQuat(data.getInt16(8 + 21 * i), data.getInt16(10 + 21 * i), data.getInt16(12 + 21 * i), data.getInt16(14 + 21 * i), previousQuat);
				previousQuat = unit;
				const quat = {
					...unit,
					...stamp
				};
				samples.push({
					...stamp,
					acc,
					quat,
					gyro,
					converted_acc: {
						x: acc.x * accRange,
						y: acc.y * accRange,
						z: acc.z * accRange,
						...stamp
					},
					converted_gyro: {
						x: gyroRawToDps(gyro.x * 32768, gyroRange),
						y: gyroRawToDps(gyro.y * 32768, gyroRange),
						z: gyroRawToDps(gyro.z * 32768, gyroRange),
						...stamp
					},
					euler: quatToEuler(quat)
				});
			}
			return samples;
		}
		if (header === 40) {
			if (data.byteLength < 17) return null;
			const quatScale = 16384;
			const gyro = {
				x: data.getInt8(9) / 127,
				y: data.getInt8(10) / 127,
				z: data.getInt8(11) / 127
			};
			const acc = {
				x: data.getInt8(14) / 127,
				y: data.getInt8(15) / 127,
				z: data.getInt8(16) / 127
			};
			const quat = {
				w: data.getInt16(1) / quatScale,
				x: data.getInt16(3) / quatScale,
				y: data.getInt16(5) / quatScale,
				z: data.getInt16(7) / quatScale
			};
			return [{
				acc,
				quat,
				gyro,
				converted_acc: {
					x: acc.x * accRange,
					y: acc.y * accRange,
					z: acc.z * accRange
				},
				converted_gyro: {
					x: gyroRawToDps(data.getInt8(9) * 256, gyroRange),
					y: gyroRawToDps(data.getInt8(10) * 256, gyroRange),
					z: gyroRawToDps(data.getInt8(11) * 256, gyroRange)
				},
				euler: quatToEuler(normalizeQuaternionCoreStyle(quat))
			}];
		}
		return null;
	}
	/** header 50 の quat（固定小数点の int16）を単位クォータニオンにする。ノルムがほぼ 0 なら直前の姿勢を維持 */
	function normalizeFrameQuat(w, x, y, z, previous) {
		const norm = Math.sqrt(w * w + x * x + y * y + z * z);
		if (norm > 1e-6) return {
			w: w / norm,
			x: x / norm,
			y: y / norm,
			z: z / norm
		};
		if (previous && Math.hypot(previous.w, previous.x, previous.y, previous.z) > 1e-6) return {
			w: previous.w,
			x: previous.x,
			y: previous.y,
			z: previous.z
		};
		return {
			w: 1,
			x: 0,
			y: 0,
			z: 0
		};
	}
	/**
	* STEP_ANALYSIS packet（20byte）のステートレスなデコード。
	* 重複配送の抑止（steps 単調増加フィルタ）は CoreProfile 側で行う。
	*/
	function decodeCoreStepAnalysis(data) {
		if (data.byteLength < 20) return null;
		const subheader = data.getUint8(1);
		const packet = {
			subheader,
			steps: data.getUint16(2)
		};
		if (subheader === 0) {
			const flags = data.getUint8(4);
			packet.gait = {
				type: (flags & 192) >>> 6,
				direction: (flags & 56) >>> 3,
				calorie: getFloat16(data, 6),
				distance: data.getFloat32(8),
				standing_phase_duration: data.getFloat32(12),
				swing_phase_duration: data.getFloat32(16)
			};
		} else if (subheader === 1) packet.stride = {
			foot_angle: data.getFloat32(4),
			x: data.getFloat32(8),
			y: data.getFloat32(12),
			z: data.getFloat32(16)
		};
		else if (subheader === 2) packet.pronation = {
			landing_impact: data.getFloat32(4),
			x: data.getFloat32(8),
			y: data.getFloat32(12),
			z: data.getFloat32(16)
		};
		else if (subheader === 4) {
			packet.quat = {
				w: getFloat16(data, 6),
				x: getFloat16(data, 8),
				y: getFloat16(data, 10),
				z: getFloat16(data, 12)
			};
			packet.delta = {
				x: getFloat16(data, 14),
				y: getFloat16(data, 16),
				z: getFloat16(data, 18)
			};
		}
		return packet;
	}
	/** DEVICE_INFORMATION の read ペイロードをデコードする */
	function decodeCoreDeviceInformation(data) {
		return {
			battery: data.getUint8(0),
			lr: data.getUint8(1),
			rec_mode: data.getUint8(2),
			rec_auto_run: data.getUint8(3),
			led_brightness: data.getUint8(4),
			time01: data.getUint8(6),
			time02: data.getUint8(7),
			range: {
				acc: data.getUint8(8),
				gyro: data.getUint8(9)
			},
			raw: data
		};
	}
	/** setDeviceInformation の書込 payload */
	function encodeCoreDeviceInformation(info) {
		return Uint8Array.from([
			DEVICE_INFORMATION_OPCODE.WRITE_SETTINGS,
			info.lr,
			info.led_brightness,
			0,
			info.rec_auto_run,
			info.time01,
			info.time02,
			info.range.acc,
			info.range.gyro
		]);
	}
	function indexFromRange(ranges, physical) {
		const index = ranges.indexOf(Number(physical));
		return index >= 0 ? index : null;
	}
	/**
	* ORPHE CORE 用の chooser フィルタ。
	* 標準は services フィルタのみ（CR-2 / CR-3 実機は advertisement に
	* service UUID を載せている）。
	*
	* `namePrefix` を渡すと OR フィルタ（名前でもサービスUUIDでもヒット）になる。
	* service UUID を advertise しない環境や同居接続で名前でも拾いたい場合に使う。
	*/
	function coreRequestDeviceOptions(options = {}) {
		const filters = [];
		if (options.namePrefix) filters.push({ namePrefix: options.namePrefix });
		filters.push({ services: [ORPHE_UUID.INFORMATION_SERVICE] });
		return {
			filters,
			acceptAllDevices: false,
			optionalServices: [ORPHE_UUID.INFORMATION_SERVICE, ORPHE_UUID.OTHER_SERVICE]
		};
	}
	/** 取付位置（lr）にこの値を書くと、FW は現在の取付位置を変えない */
	var KEEP_MOUNT_POSITION = 255;
	/** CoreProfile と GATT 操作から {@link CoreCommands} を作る */
	function coreCommands(profile, io) {
		const current = async () => profile.device_information ?? commands.readDeviceInformation();
		const commands = {
			async readDeviceInformation() {
				profile.device_information = decodeCoreDeviceInformation(await io.read("DEVICE_INFORMATION"));
				return profile.device_information;
			},
			async writeDeviceInformation(settings) {
				await io.write("DEVICE_INFORMATION", encodeCoreDeviceInformation(settings));
				const info = profile.device_information;
				if (info) {
					const lr = settings.lr === KEEP_MOUNT_POSITION ? info.lr : settings.lr;
					profile.device_information = {
						...info,
						...settings,
						lr,
						range: { ...settings.range },
						raw: info.raw
					};
				}
			},
			async setRange(range) {
				const info = await current();
				const acc = indexFromRange(CORE_ACC_RANGES, range.acc);
				const gyro = indexFromRange(CORE_GYRO_RANGES, range.gyro);
				if (range.acc !== void 0 && acc === null) throw new TransportError("INVALID_MODE", `Invalid acc range: ${range.acc}. Use ${CORE_ACC_RANGES.join(" | ")}.`);
				if (range.gyro !== void 0 && gyro === null) throw new TransportError("INVALID_MODE", `Invalid gyro range: ${range.gyro}. Use ${CORE_GYRO_RANGES.join(" | ")}.`);
				await commands.writeDeviceInformation({
					...info,
					lr: KEEP_MOUNT_POSITION,
					range: {
						acc: acc ?? info.range.acc,
						gyro: gyro ?? info.range.gyro
					}
				});
			},
			setLED(on, pattern = 0) {
				return io.write("DEVICE_INFORMATION", [
					DEVICE_INFORMATION_OPCODE.SET_LED,
					on ? 1 : 0,
					pattern
				]);
			},
			async setLEDBrightness(value) {
				const info = await current();
				await commands.writeDeviceInformation({
					...info,
					lr: KEEP_MOUNT_POSITION,
					led_brightness: value
				});
			},
			async setMountPosition(position) {
				if (!Number.isInteger(position) || position < 0 || position > 3) throw new TransportError("INVALID_MODE", `Invalid mount position: ${position}. Use 0..3.`);
				const info = await commands.readDeviceInformation();
				await commands.writeDeviceInformation({
					...info,
					lr: position
				});
			},
			resetAttitude() {
				return io.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ATTITUDE]);
			},
			resetAnalysisLogs() {
				profile.resetAnalysisState();
				return io.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ANALYSIS_LOGS]);
			}
		};
		return commands;
	}
	/** begin() に渡せる notification type の一覧 */
	var CORE_NOTIFICATION_TYPES = Object.freeze([
		"STEP_ANALYSIS",
		"SENSOR_VALUES",
		"STEP_ANALYSIS_AND_SENSOR_VALUES"
	]);
	var CoreProfile = class {
		kind = "core";
		defaultNotificationType = "STEP_ANALYSIS";
		/** begin() で取得したデバイス設定。parse() の換算レンジに使う */
		device_information = null;
		defaults;
		stepsNumber = 0;
		gaitSteps = 0;
		strideSteps = 0;
		pronationSteps = 0;
		serialNumber = null;
		lastQuat = null;
		constructor(options = {}) {
			this.defaults = options;
		}
		storageKey(id) {
			return `orphe_last_bluetooth_device_${id}`;
		}
		/** chooser の namePrefix フィルタを変える（次に chooser を開くときから効く。undefined で外す） */
		setNamePrefix(namePrefix) {
			this.defaults = {
				...this.defaults,
				namePrefix
			};
		}
		requestDeviceOptions() {
			return coreRequestDeviceOptions(this.defaults.namePrefix ? { namePrefix: this.defaults.namePrefix } : {});
		}
		characteristics() {
			return orpheCharacteristics();
		}
		modes() {
			return CORE_MODES.map((mode) => ({ ...mode }));
		}
		/** デバイスコマンド（LED・姿勢リセットなど）。通常は `ble.commands` から使う */
		commands(io) {
			return coreCommands(this, io);
		}
		/** resetAnalysisLogs 相当の内部カウンタ初期化 */
		resetAnalysisState() {
			this.stepsNumber = 0;
			this.gaitSteps = 0;
			this.strideSteps = 0;
			this.pronationSteps = 0;
		}
		async begin(context) {
			const { transport, options } = context;
			const type = normalizeNotificationType(context.notificationType);
			this.serialNumber = null;
			const infoData = await transport.read("DEVICE_INFORMATION", options);
			this.device_information = decodeCoreDeviceInformation(infoData);
			const range = options.range ?? {};
			const accIndex = indexFromRange(CORE_ACC_RANGES, range.acc);
			const gyroIndex = indexFromRange(CORE_GYRO_RANGES, range.gyro);
			if (accIndex !== null) this.device_information.range.acc = accIndex;
			if (gyroIndex !== null) this.device_information.range.gyro = gyroIndex;
			await transport.write("DEVICE_INFORMATION", encodeCoreDeviceInformation(this.device_information));
			const settleMs = this.defaults.settleMs ?? 500;
			if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
			await syncDeviceTime(transport, { samples: this.defaults.timeSyncSamples ?? 3 });
			if (type === "STEP_ANALYSIS") {
				await transport.startNotify("STEP_ANALYSIS", options);
				return "done begin(); STEP ANALYSIS";
			}
			if (type === "SENSOR_VALUES") {
				await transport.startNotify("SENSOR_VALUES", options);
				return "done begin(); SENSOR VALUES";
			}
			await transport.startNotify("STEP_ANALYSIS", options);
			await transport.startNotify("SENSOR_VALUES", options);
			return "done begin(); STEP_ANALYSIS and SENSOR VALUES";
		}
		parse(uuid, data) {
			if (uuid === "SENSOR_VALUES") {
				if (this.defaults.acceptExtendedSensorValues && data.byteLength === 104 && data.getUint8(0) === 50) data = new DataView(data.buffer, data.byteOffset, 92);
				const samples = [];
				if (data.byteLength >= 3 && data.getUint8(0) === 50) {
					const loss = this.checkSerialGap(data.getUint16(1));
					if (loss) samples.push({ lost_data: loss });
				}
				const parsed = parseCoreSensorValues(data, {
					...this.sensorParseOptions(),
					previousQuat: this.lastQuat
				});
				if (parsed) {
					samples.push(...parsed);
					this.rememberQuat(parsed[parsed.length - 1]?.quat);
				}
				return samples.length > 0 ? samples : null;
			}
			if (uuid === "STEP_ANALYSIS") return this.parseStepAnalysis(data);
			return null;
		}
		checkSerialGap(current) {
			const prev = this.serialNumber;
			this.serialNumber = current;
			if (prev === null) return null;
			return (current - prev + 65536) % 65536 === 1 ? null : {
				serial: current,
				prev
			};
		}
		/**
		* 取得済みレンジ設定 index → パーサーのフルスケール値（未取得・範囲外は 16G/2000dps）。
		*
		* @internal
		*/
		sensorParseOptions() {
			const { acc, gyro } = imuRangeFromSettings(this.device_information?.range);
			return {
				accRange: acc,
				gyroRange: gyro
			};
		}
		rememberQuat(quat) {
			if (quat) this.lastQuat = {
				w: quat.w,
				x: quat.x,
				y: quat.y,
				z: quat.z
			};
		}
		parseStepAnalysis(data) {
			const packet = decodeCoreStepAnalysis(data);
			if (!packet) return null;
			const { subheader, steps } = packet;
			const sample = {};
			if (subheader >= 0 && subheader <= 2 && steps > this.stepsNumber) {
				sample.steps_number = { value: steps };
				this.stepsNumber = steps;
			}
			if (subheader === 0 && packet.gait && steps > this.gaitSteps) {
				this.gaitSteps = steps;
				const gait = {
					...packet.gait,
					steps
				};
				sample.gait = gait;
				sample.type = { value: gait.type };
				sample.distance = { value: gait.distance };
				sample.direction = { value: gait.direction };
				sample.calorie = { value: gait.calorie };
				sample.standing_phase_duration = { value: gait.standing_phase_duration };
				sample.swing_phase_duration = { value: gait.swing_phase_duration };
			} else if (subheader === 1 && packet.stride && steps > this.strideSteps) {
				this.strideSteps = steps;
				sample.foot_angle = { value: packet.stride.foot_angle };
				sample.stride = {
					x: packet.stride.x,
					y: packet.stride.y,
					z: packet.stride.z,
					steps_number: steps
				};
			} else if (subheader === 2 && packet.pronation && steps > this.pronationSteps) {
				this.pronationSteps = steps;
				sample.pronation = {
					x: packet.pronation.x,
					y: packet.pronation.y,
					z: packet.pronation.z
				};
				sample.landing_impact = { value: packet.pronation.landing_impact };
			} else if (subheader === 4 && packet.quat && packet.delta) {
				sample.quat = packet.quat;
				sample.delta = packet.delta;
				this.rememberQuat(packet.quat);
				sample.euler = quatToEuler(packet.quat);
			}
			return Object.keys(sample).length > 0 ? [sample] : null;
		}
	};
	function normalizeNotificationType(type) {
		if (type === "RAW") {
			console.warn("RAW is deprecated. Please use SENSOR_VALUES instead.");
			return "SENSOR_VALUES";
		}
		if (type === "ANALYSIS") {
			console.warn("ANALYSIS is deprecated. Please use STEP_ANALYSIS instead.");
			return "STEP_ANALYSIS";
		}
		if (type === "ANALYSIS_AND_RAW") {
			console.warn("ANALYSIS_AND_RAW is deprecated. Please use STEP_ANALYSIS_AND_SENSOR_VALUES instead.");
			return "STEP_ANALYSIS_AND_SENSOR_VALUES";
		}
		if (!CORE_NOTIFICATION_TYPES.includes(type)) throw new TransportError("INVALID_MODE", `Invalid ORPHE CORE notification type: ${type}. Use ${CORE_NOTIFICATION_TYPES.join(" | ")}.`);
		return type;
	}
	/** ORPHE CORE 用の DeviceProfile を生成する */
	function coreProfile(options = {}) {
		return new CoreProfile(options);
	}
	//#endregion
	//#region src/profiles/auto.ts
	/** INSOLE のデバイス名の接頭辞（advertise 名は `INS...`） */
	var INSOLE_NAME_PREFIX = "INS";
	/**
	* デバイス名から種別を判別する。`INS` で始まれば INSOLE、それ以外（名前が取れない場合を含む）は CORE。
	* chooser は ORPHE の service UUID か `INS` の名前でしか候補を出さないため、INSOLE 以外は CORE とみなせる。
	*/
	function detectDeviceKind(name) {
		return name?.startsWith(INSOLE_NAME_PREFIX) ? "insole" : "core";
	}
	/** 重複を除いて連結する（filters のようなオブジェクトは JSON で比較する） */
	function unique(items) {
		const seen = /* @__PURE__ */ new Set();
		return items.filter((item) => {
			const key = JSON.stringify(item);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	var AutoProfile = class {
		/** CORE と判別したときに使うプロファイル */
		core;
		/** INSOLE と判別したときに使うプロファイル */
		insole;
		resolved = null;
		constructor(options = {}) {
			this.core = new CoreProfile(options.core);
			this.insole = new InsoleProfile(options.insole);
		}
		/** 判別済みのプロファイル。接続前は null */
		get current() {
			return this.resolved;
		}
		/** 判別済みなら 'core' / 'insole'、接続前は 'auto' */
		get kind() {
			return this.resolved?.kind ?? "auto";
		}
		/** 判別後のプロファイルの既定 type。接続前は CORE の既定を返す */
		get defaultNotificationType() {
			return (this.resolved ?? this.core).defaultNotificationType;
		}
		/** 判別後のプロファイルが begin() で取得したデバイス設定 */
		get device_information() {
			return this.resolved?.device_information ?? null;
		}
		/** INSOLE の現在ストリーミングモード（FIFO の復帰先）。CORE・接続前は null */
		get streaming_mode() {
			return this.resolved === this.insole ? this.insole.streaming_mode : null;
		}
		/** FifoRecorder が停止時に復帰先を書き戻す。INSOLE のときだけ反映する */
		set streaming_mode(mode) {
			if (this.resolved === this.insole) this.insole.streaming_mode = mode;
		}
		/** INSOLE の個体別圧力校正係数。CORE・接続前は null */
		get pressure_calibrations() {
			return this.resolved === this.insole ? this.insole.pressure_calibrations : null;
		}
		storageKey(id) {
			return `orphe_core_insole_last_bluetooth_device_${id}`;
		}
		requestDeviceOptions() {
			const insole = this.insole.requestDeviceOptions();
			const core = this.core.requestDeviceOptions();
			return {
				filters: unique([...insole.filters ?? [], ...core.filters ?? []]),
				acceptAllDevices: false,
				optionalServices: unique([...insole.optionalServices ?? [], ...core.optionalServices ?? []]),
				optionalManufacturerData: unique([...insole.optionalManufacturerData ?? [], ...core.optionalManufacturerData ?? []])
			};
		}
		characteristics() {
			return orpheCharacteristics();
		}
		/** 選ばれたデバイスの名前でプロファイルを決める（begin() の中で接続シーケンスより先に呼ばれる） */
		resolveDevice(name, log) {
			const kind = detectDeviceKind(name);
			this.resolved = kind === "insole" ? this.insole : this.core;
			log?.("autoProfile: デバイス種別を判別", {
				name,
				kind
			});
		}
		modes() {
			return this.resolved ? this.resolved.modes() : [];
		}
		/** INSOLE と判別していればアドバタイズを解釈する */
		parseAdvertisement(event) {
			return this.resolved === this.insole ? this.insole.parseAdvertisement(event) : null;
		}
		/** 判別済みプロファイルのコマンド。未判別なら throw する */
		commands(io) {
			return this.requireResolved().commands(io);
		}
		begin(context) {
			return this.requireResolved().begin(context);
		}
		parse(uuid, data) {
			return this.resolved ? this.resolved.parse(uuid, data) : null;
		}
		requireResolved() {
			if (!this.resolved) throw new Error("autoProfile: デバイスが未選択のため CORE / INSOLE を判別できない");
			return this.resolved;
		}
	};
	/** 接続したデバイスの名前で CORE / INSOLE を切り替えるプロファイルを作る */
	function autoProfile(options = {}) {
		return new AutoProfile(options);
	}
	//#endregion
	//#region src/bridge.ts
	var DEFAULT_HEARTBEAT_INTERVAL_MS = 1e3;
	var DEFAULT_HEARTBEAT_TIMEOUT_MS = 5e3;
	var DEFAULT_WATCH_INTERVAL_MS = 2e3;
	var DEFAULT_ELECTION_MAX_DELAY_MS = 1500;
	/** ブラウザのグローバルをそのまま使う既定環境 */
	function defaultBridgeEnvironment() {
		return {
			storage: localStorage,
			createChannel(name) {
				try {
					return new BroadcastChannel(name);
				} catch (error) {
					console.warn("[BleSharedBridge] BroadcastChannel unavailable:", error);
					return null;
				}
			},
			addWindowListener(type, listener) {
				globalThis.addEventListener(type, listener);
			},
			removeWindowListener(type, listener) {
				globalThis.removeEventListener(type, listener);
			}
		};
	}
	/**
	* タブ間で BLE 接続を共有するブリッジ。
	* Primary タブが接続を保持し、パース済みサンプルを BroadcastChannel で配る。
	*/
	var BleSharedBridge = class {
		/** 共有対象のデバイス識別子（storage キーとチャネル名に使う） */
		deviceId;
		/** このタブが Primary（BLE 接続を保持する側）なら true */
		isPrimary = false;
		/** Primary 喪失時のリーダー選出用最大遅延（SDK 層が利用する） */
		electionMaxDelayMs;
		env;
		storageKey;
		channelName;
		tabId;
		heartbeatIntervalMs;
		heartbeatTimeoutMs;
		watchIntervalMs;
		channel = null;
		heartbeatInterval = null;
		watchInterval = null;
		storageListener = null;
		pagehideListener = null;
		callbacks = {};
		primaryLostFired = false;
		constructor(deviceId, env = defaultBridgeEnvironment(), timing = {}) {
			this.deviceId = deviceId;
			this.env = env;
			this.storageKey = `orphe_bridge_primary_${deviceId}`;
			this.channelName = `orphe-device-bridge-${deviceId}`;
			this.tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			this.heartbeatIntervalMs = timing.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
			this.heartbeatTimeoutMs = timing.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
			this.watchIntervalMs = timing.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
			this.electionMaxDelayMs = timing.electionMaxDelayMs ?? DEFAULT_ELECTION_MAX_DELAY_MS;
		}
		/** 別タブに有効な Primary が存在するか */
		isRemotePrimaryAvailable() {
			try {
				const raw = this.env.storage.getItem(this.storageKey);
				if (!raw) return false;
				const { timestamp, tabId } = JSON.parse(raw);
				return tabId !== this.tabId && Date.now() - timestamp < this.heartbeatTimeoutMs;
			} catch {
				return false;
			}
		}
		/** このタブを Primary として登録し、BroadcastChannel を開く */
		claimPrimary() {
			this.isPrimary = true;
			this.openChannel();
			this.updateHeartbeat();
			this.heartbeatInterval = setInterval(() => this.updateHeartbeat(), this.heartbeatIntervalMs);
			this.pagehideListener = () => {
				this.cleanupOwnPrimaryEntry();
				this.send({
					type: "disconnected",
					deviceId: this.deviceId
				});
			};
			this.env.addWindowListener("pagehide", this.pagehideListener);
		}
		/** 複数のコールバック呼び出しを1メッセージにまとめてブロードキャストする */
		broadcastBatch(batch) {
			if (!this.isPrimary || !this.channel) return;
			this.send({
				type: "batch",
				deviceId: this.deviceId,
				batch
			});
		}
		/** 単一コールバックをブロードキャストする（broadcastBatch の単一キー版） */
		broadcast(callbackName, data) {
			this.broadcastBatch({ [callbackName]: data });
		}
		/** 切断を全タブへ通知し、Primary リソースを解放する */
		broadcastDisconnect() {
			this.send({
				type: "disconnected",
				deviceId: this.deviceId
			});
			this.release();
		}
		/** このタブを Secondary として BroadcastChannel を購読する */
		subscribeAsSecondary(callbacks) {
			this.isPrimary = false;
			this.callbacks = callbacks;
			this.openChannel();
			if (this.channel) this.channel.onmessage = (event) => this.handleMessage(event.data);
			this.storageListener = (event) => {
				const e = event;
				if (e.key !== this.storageKey) return;
				if (e.newValue === null) this.firePrimaryLost();
			};
			this.env.addWindowListener("storage", this.storageListener);
			this.watchInterval = setInterval(() => {
				if (!this.isRemotePrimaryAvailable()) this.firePrimaryLost();
			}, this.watchIntervalMs);
		}
		/** すべてのリソースを解放する */
		release() {
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}
			if (this.watchInterval) {
				clearInterval(this.watchInterval);
				this.watchInterval = null;
			}
			if (this.storageListener) {
				this.env.removeWindowListener("storage", this.storageListener);
				this.storageListener = null;
			}
			if (this.pagehideListener) {
				this.env.removeWindowListener("pagehide", this.pagehideListener);
				this.pagehideListener = null;
			}
			if (this.isPrimary) this.cleanupOwnPrimaryEntry();
			if (this.channel) {
				try {
					this.channel.close();
				} catch {}
				this.channel = null;
			}
			this.isPrimary = false;
		}
		openChannel() {
			if (this.channel) return;
			this.channel = this.env.createChannel(this.channelName);
		}
		send(message) {
			try {
				this.channel?.postMessage(message);
			} catch {}
		}
		updateHeartbeat() {
			try {
				this.env.storage.setItem(this.storageKey, JSON.stringify({
					timestamp: Date.now(),
					tabId: this.tabId
				}));
			} catch {}
		}
		/**
		* storage から自分の Primary エントリのみを削除する
		* （他タブが既に Primary を奪取している場合は何もしない）
		*/
		cleanupOwnPrimaryEntry() {
			try {
				const raw = this.env.storage.getItem(this.storageKey);
				if (!raw) return;
				const { tabId } = JSON.parse(raw);
				if (tabId === this.tabId) this.env.storage.removeItem(this.storageKey);
			} catch {}
		}
		handleMessage(message) {
			const msg = message;
			if (!msg || msg.deviceId !== this.deviceId) return;
			if (msg.type === "batch" && msg.batch) for (const name in msg.batch) {
				const callback = this.callbacks[name];
				if (typeof callback === "function") callback(msg.batch[name]);
			}
			else if (msg.type === "disconnected") this.firePrimaryLost();
		}
		/** onPrimaryLost を1回だけ発火する（重複検知してもループしない） */
		firePrimaryLost() {
			if (this.primaryLostFired) return;
			this.primaryLostFired = true;
			if (this.watchInterval) {
				clearInterval(this.watchInterval);
				this.watchInterval = null;
			}
			const callback = this.callbacks.onPrimaryLost;
			if (typeof callback === "function") callback();
		}
	};
	//#endregion
	//#region src/device/shared-bridge.ts
	/**
	* OrpheCoreInsole のタブ間共有（BleSharedBridge）を束ねる内部モジュール。
	*
	*   await ble.begin('SENSOR_VALUES', { useSharedBridge: true });
	*
	* - 別タブが同じスロットの BLE 接続を持っていれば、BLE に触らずそのタブから配信を受ける（Secondary）
	* - 持っていなければ自分が接続し、パース済みサンプルを他タブへ配る（Primary）
	* - Primary タブを失った Secondary は、ランダム遅延のあと別タブが Primary になっていれば Secondary に戻り、
	*   いなければ記憶デバイスで自分が接続し直す
	*/
	/** structured clone できない値（DataView など）を配信から外す */
	function cloneable(value) {
		if (value === null || typeof value !== "object") return typeof value !== "function";
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
		return true;
	}
	var SharedBridgeLink = class {
		role = null;
		bridge = null;
		detachBroadcast = null;
		detachDisconnect = null;
		host;
		options;
		constructor(host, options = {}) {
			this.host = host;
			this.options = options;
		}
		/** 現在の役割。共有していなければ null */
		get currentRole() {
			return this.role;
		}
		/** ブリッジを作る。ブラウザ環境が無ければ（Node など）null */
		createBridge() {
			if (this.options.environment) return new BleSharedBridge(this.host.id, this.options.environment, this.options.timing);
			const g = globalThis;
			if (typeof g.window === "undefined" || typeof g.localStorage === "undefined") return null;
			return new BleSharedBridge(this.host.id, void 0, this.options.timing);
		}
		/** 別タブに Primary がいれば Secondary として購読し true を返す */
		joinIfRemotePrimary(type, options) {
			const bridge = this.createBridge();
			if (!bridge) return false;
			if (!bridge.isRemotePrimaryAvailable()) {
				bridge.release();
				return false;
			}
			this.joinAsSecondary(bridge, type, options);
			return true;
		}
		joinAsSecondary(bridge, type, options) {
			this.bridge = bridge;
			this.role = "secondary";
			const callbacks = new Proxy({}, { get: (_target, name) => {
				if (name === "onPrimaryLost") return () => {
					this.handlePrimaryLost(type, options);
				};
				if (typeof name !== "string") return void 0;
				return (data) => this.host.emitter.emit("BRIDGE", [{ [name]: data }]);
			} });
			bridge.subscribeAsSecondary(callbacks);
			this.host.emitLifecycle("onConnect", "BRIDGE_SECONDARY");
		}
		/** 自分が BLE 接続を持ったので Primary として配信を始める */
		claimPrimary() {
			const bridge = this.createBridge();
			if (!bridge) return;
			this.bridge = bridge;
			this.role = "primary";
			bridge.claimPrimary();
			this.detachBroadcast = this.host.on("*", (sample) => {
				const batch = {};
				for (const [field, value] of Object.entries(sample)) if (value !== void 0 && cloneable(value)) batch[field] = value;
				if (Object.keys(batch).length > 0) bridge.broadcastBatch(batch);
			});
			this.detachDisconnect = this.host.transport.addDisconnectHook(() => {
				if (this.bridge === bridge && bridge.isPrimary) {
					bridge.broadcastDisconnect();
					this.detach();
				}
			});
		}
		/**
		* Primary タブを失ったときの復帰。ランダム遅延の後、他タブが Primary になっていれば
		* Secondary に戻り、いなければ記憶デバイスで自分が接続する。
		*/
		async handlePrimaryLost(type, options) {
			if (this.role !== "secondary") return;
			const delayMax = this.bridge?.electionMaxDelayMs ?? 0;
			this.detach();
			this.host.emitLifecycle("onDisconnect", { reason: "bridge-primary-lost" });
			await new Promise((resolve) => setTimeout(resolve, Math.random() * delayMax));
			const probe = this.createBridge();
			if (probe?.isRemotePrimaryAvailable()) {
				this.joinAsSecondary(probe, type, options);
				return;
			}
			probe?.release();
			try {
				await this.host.begin(type, {
					...options,
					useSharedBridge: true
				});
			} catch (error) {
				this.host.reportError(/* @__PURE__ */ new Error(`Primary tab closed. Please reconnect manually. (${error instanceof Error ? error.message : String(error)})`));
			}
		}
		detach() {
			this.detachBroadcast?.();
			this.detachBroadcast = null;
			this.detachDisconnect?.();
			this.detachDisconnect = null;
			this.bridge = null;
			this.role = null;
		}
		/** 共有をやめる。Primary なら他タブへ切断を知らせる */
		release() {
			const bridge = this.bridge;
			if (bridge) {
				if (bridge.isPrimary) bridge.broadcastDisconnect();
				else bridge.release();
			}
			this.detach();
		}
	};
	//#endregion
	//#region src/device/orphe-core-insole.ts
	/** FW 情報を read する characteristic の論理名 */
	var FIRMWARE_NAME_UUID = "GET_FW_NAME";
	var OrpheCoreInsole = class {
		/** スロット番号（記憶デバイスの分離キー） */
		id;
		/**
		* デバイス種別の実装（接続シーケンス・パースを担う）。
		* coreProfile() / insoleProfile() を渡した場合はその型のまま参照できる（`ble.profile.device_information` など）
		*/
		profile;
		/** BLE トランスポート（scan / read / write / notify / 再接続） */
		transport;
		/** フィールド名 → リスナーへサンプルを配送する emitter */
		emitter;
		userEvents;
		eventListeners = /* @__PURE__ */ new Map();
		commandsCache = null;
		rawListeners = /* @__PURE__ */ new Set();
		notifySinks = /* @__PURE__ */ new Map();
		clock;
		frequencyStart = 0;
		/** 前回 begin() の type。省略時は undefined のまま持ち、再接続のたびにプロファイルの既定を使う */
		beginType;
		lastBeginOptions = {};
		hasBegun = false;
		firmwareInfo = null;
		sharedBridgeOptions;
		bridgeLink = null;
		advertisementListener = null;
		advertisementDevice = null;
		latestAdvertisement = null;
		debugLog;
		constructor(options = {}) {
			this.profile = options.profile ?? autoProfile();
			this.id = options.id ?? 0;
			this.userEvents = options.events ?? {};
			this.clock = options.clock ?? (() => performance.now());
			this.debugLog = options.log ?? (() => {});
			this.sharedBridgeOptions = options.sharedBridge ?? {};
			this.emitter = new SampleEmitter((error) => this.userEvents.onError?.(error));
			const delegate = (name) => (...args) => {
				this.fireListeners(name, args);
				const callback = this.userEvents[name];
				callback?.(...args);
			};
			this.transport = new OrpheBleTransport({
				requestDeviceOptions: () => this.profile.requestDeviceOptions(),
				storageKey: this.profile.storageKey(this.id),
				characteristics: this.profile.characteristics(),
				reconnect: options.reconnect,
				reconnectConnect: () => this.runBegin(this.beginType, this.lastBeginOptions),
				connectTimeoutMs: options.connectTimeoutMs,
				deviceGuard: options.deviceGuard,
				bluetooth: options.bluetooth,
				storage: options.storage,
				log: options.log,
				wait: options.wait,
				events: {
					onScan: delegate("onScan"),
					onConnect: delegate("onConnect"),
					onDisconnect: delegate("onDisconnect"),
					onError: (error) => this.reportError(error),
					onWrite: delegate("onWrite"),
					onStartNotify: delegate("onStartNotify"),
					onStopNotify: delegate("onStopNotify"),
					onReconnectAttempt: delegate("onReconnectAttempt"),
					onReconnectSuccess: delegate("onReconnectSuccess"),
					onReconnectFailed: delegate("onReconnectFailed"),
					onNotification: (uuid, value) => {
						const sink = this.notifySinks.get(uuid);
						if (sink) {
							try {
								sink(value);
							} catch (error) {
								this.reportError(error);
							}
							return;
						}
						const frequency = this.measureFrequencyHz();
						if (frequency > 0) this.emitter.emit(uuid, [{ ble_frequency: frequency }]);
						for (const listener of [...this.rawListeners]) try {
							listener(uuid, value);
						} catch (error) {
							this.reportError(error);
						}
						const samples = this.profile.parse(uuid, value);
						if (samples && samples.length > 0) this.emitter.emit(uuid, samples);
						this.userEvents.onNotification?.(uuid, value);
					}
				}
			});
		}
		/**
		* 正規化フィールド名（'acc' / 'gyro' / 'quat' / 'press' ...）で購読する。
		* キーとペイロード型はプロファイルの TFields から推論される（補完が効く）。
		* '*' はサンプル全体。解除関数を返す。
		*/
		on(field, listener) {
			return this.emitter.on(field, listener);
		}
		/**
		* パース前の生 DataView を購読する（uuid は論理名）。解除関数を返す。
		* attachLegacyCallbacks の gotData 配送などが使う。
		*/
		onRaw(listener) {
			this.rawListeners.add(listener);
			return () => {
				this.rawListeners.delete(listener);
			};
		}
		/**
		* uuid（論理名）の notify を横取りする sink を設定する。FIFO 収録や歩容解析の
		* ように、request/response プロトコルの応答を通常のセンサー配送から切り離して
		* 消費するモジュール用。設定中はその uuid の通知が sink のみに渡る。
		* 解除関数を返す。同じ uuid への多重設定はエラー（横取りの奪い合い事故防止）。
		*/
		setNotifySink(uuid, sink) {
			if (this.notifySinks.has(uuid)) throw new Error(`OrpheCoreInsole.setNotifySink: sink already installed for ${uuid}`);
			this.notifySinks.set(uuid, sink);
			return () => {
				if (this.notifySinks.get(uuid) === sink) this.notifySinks.delete(uuid);
			};
		}
		/**
		* ライフサイクルイベント（'onConnect' / 'onDisconnect' / 'onStartNotify' / 'onError' /
		* 'onReconnectSuccess' など）を購読する。解除関数を返す。
		* コンストラクタの `events` と違い、構築後に何個でも足せる（toolkit が作ったインスタンスにも使える）。
		* 購読者はコンストラクタの `events` より先に呼ばれる。
		*/
		onEvent(name, listener) {
			let listeners = this.eventListeners.get(name);
			if (!listeners) {
				listeners = /* @__PURE__ */ new Set();
				this.eventListeners.set(name, listeners);
			}
			const callback = listener;
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		}
		/**
		* onEvent() の購読者へライフサイクルイベントを配送する。
		* 購読者の throw は他の購読者を止めず onError へ報告する（onError の購読者の throw は握りつぶす）。
		* transport を通らないイベント（タブ間共有の Secondary 接続など）の発火にも使う。
		*
		* @internal
		*/
		fireListeners(name, args) {
			const listeners = this.eventListeners.get(name);
			if (!listeners || listeners.size === 0) return;
			for (const listener of [...listeners]) try {
				const result = listener(...args);
				if (result && typeof result.catch === "function") result.catch((error) => {
					if (name !== "onError") this.reportError(error);
				});
			} catch (error) {
				if (name !== "onError") this.reportError(error);
			}
		}
		/**
		* ライフサイクルイベントを onEvent() の購読者とコンストラクタの `events` の両方へ発火する。
		*
		* @internal
		*/
		emitLifecycle(name, ...args) {
			this.fireListeners(name, args);
			const callback = this.userEvents[name];
			try {
				callback?.(...args);
			} catch (error) {
				if (name !== "onError") this.reportError(error);
			}
		}
		/** コールバック例外などを onError へ安全に報告する（throw は伝播しない） */
		reportError(error) {
			this.fireListeners("onError", [error]);
			try {
				this.userEvents.onError?.(error);
			} catch {}
		}
		/**
		* デバイス固有コマンド。CORE は LED・レンジ・姿勢リセットなど（{@link CoreCommands}）、
		* INSOLE はストリーミングモード切替など（{@link InsoleCommands}）。
		* autoProfile では接続して種別が決まるまで使えない（throw する）。
		*/
		get commands() {
			if (!this.profile.commands) throw new Error(`OrpheCoreInsole.commands: profile "${this.profile.kind}" does not provide commands`);
			const kind = this.profile.kind;
			if (!this.commandsCache || this.commandsCache.kind !== kind) this.commandsCache = {
				kind,
				commands: this.profile.commands(this.transport)
			};
			return this.commandsCache.commands;
		}
		/** デバイスの時刻を読む（往復時間つき） */
		readDateTime() {
			return readDateTime(this.transport);
		}
		/** Date をデバイスの時刻として書き込む */
		writeDateTime(date) {
			return writeDateTime(this.transport, date);
		}
		/**
		* デバイスの時計を PC 時刻 + 平均往復時間/2 に合わせる。
		* begin() の中でも自動で行われるので、通常は呼ばなくてよい。
		*/
		syncTime(options) {
			return syncDeviceTime(this.transport, options);
		}
		/** 前回 notify からの経過時間 → 周波数 [Hz]。15ms 以下は -1（間引き） */
		measureFrequencyHz() {
			const now = this.clock();
			const diff = now - this.frequencyStart;
			this.frequencyStart = now;
			if (diff <= 15) return -1;
			return 1e3 / diff;
		}
		/**
		* 接続中デバイスのファームウェア情報。begin() の中で 1 回だけ read してキャッシュする。
		* 未接続、または FW 情報を持たない個体では null。
		*/
		get firmware() {
			return this.firmwareInfo;
		}
		/**
		* 接続中の FW で実際に使える取得モードだけを返す。
		* FW 情報が取れない個体（旧 FW など）は判定できないため絞り込まない。
		*/
		get availableModes() {
			const modes = this.profile.modes ? this.profile.modes() : [];
			const releaseDate = this.firmwareInfo?.releaseDate ?? null;
			if (releaseDate === null) return modes;
			return modes.filter((mode) => releaseDate >= mode.minReleaseDate);
		}
		/**
		* GET_FW_NAME を read してファームウェア情報を取り直す。
		* autoProfile のようにデバイス名で振る舞いを決めるプロファイルは、ここで CORE / INSOLE を判別する。
		* characteristic 未実装・read 失敗・日付未書込はすべて null（例外は投げない）。
		* デバイスの選択（chooser のキャンセル、別スロットへの割当済み）だけは失敗として reject する。
		*/
		async readFirmwareInfo() {
			const hasFirmwareName = this.transport.hasCharacteristic(FIRMWARE_NAME_UUID);
			if (!hasFirmwareName && !this.profile.resolveDevice) {
				this.firmwareInfo = null;
				return null;
			}
			this.transport.setConnecting(true);
			try {
				await this.transport.scan(hasFirmwareName ? FIRMWARE_NAME_UUID : "DEVICE_INFORMATION");
				this.profile.resolveDevice?.(this.transport.device?.name ?? null, this.debugLog);
				if (!hasFirmwareName) {
					this.firmwareInfo = null;
					return null;
				}
				try {
					this.firmwareInfo = decodeFirmwareInfo(await this.transport.read(FIRMWARE_NAME_UUID, { silent: true }));
				} catch {
					this.firmwareInfo = null;
				}
			} finally {
				this.transport.setConnecting(false);
			}
			return this.firmwareInfo;
		}
		/**
		* 接続してデータ取得を開始する。
		* シーケンスの中身はプロファイルが定義し、成功時にデバイスを記憶、
		* autoReconnect 指定時は以後の切断で同じシーケンスが自動再実行される。
		*/
		async begin(type, options = {}) {
			const { forceDeviceSelection, useSharedBridge, ...profileOptions } = options;
			this.beginType = type;
			this.lastBeginOptions = profileOptions;
			this.hasBegun = true;
			this.releaseSharedBridge();
			if (useSharedBridge === true) {
				const link = new SharedBridgeLink(this, this.sharedBridgeOptions);
				if (link.joinIfRemotePrimary(type, profileOptions)) {
					this.bridgeLink = link;
					return "done begin(); BRIDGE SECONDARY";
				}
			}
			if (options.autoReconnect) this.transport.enableAutoReconnect(options.reconnect ?? {});
			else if (this.transport.connectionState !== "reconnecting") this.transport.disableAutoReconnect();
			if (forceDeviceSelection) {
				this.transport.setConnecting(true);
				try {
					await this.transport.scan("DEVICE_INFORMATION", { forceDeviceSelection: true });
				} finally {
					this.transport.setConnecting(false);
				}
			}
			const result = await this.runBegin(type, profileOptions);
			if (useSharedBridge === true) {
				const link = new SharedBridgeLink(this, this.sharedBridgeOptions);
				link.claimPrimary();
				this.bridgeLink = link;
			}
			return result;
		}
		/**
		* タブ間共有（begin の useSharedBridge: true）での役割。
		* 'primary' は自分が BLE 接続を持って配信中、'secondary' は別タブの接続から受信中。共有していなければ null
		*/
		get sharedBridgeRole() {
			return this.bridgeLink?.currentRole ?? null;
		}
		/** タブ間共有だけをやめる（BLE 接続はそのまま）。Primary なら他タブへ切断を知らせる */
		releaseSharedBridge() {
			this.bridgeLink?.release();
			this.bridgeLink = null;
		}
		/** begin シーケンス本体（手動 begin と自動再接続の共通経路） */
		async runBegin(type, options) {
			this.transport.setConnecting(true);
			try {
				await this.readFirmwareInfo();
				const notificationType = type ?? this.profile.defaultNotificationType;
				const result = await this.profile.begin({
					transport: this.transport,
					notificationType,
					options,
					firmware: this.firmwareInfo,
					log: this.debugLog
				});
				this.transport.rememberCurrentDevice();
				this.transport.armAutoReconnect();
				return result;
			} finally {
				this.transport.setConnecting(false);
			}
		}
		/**
		* 直近の begin() で開始した notification type（type を省略した場合はプロファイルの既定）。
		* begin() 前は undefined。
		*/
		get lastBeginType() {
			if (!this.hasBegun) return void 0;
			return this.beginType ?? this.profile.defaultNotificationType;
		}
		/** 切断してクリアする。自動再接続も解除される */
		stop() {
			this.reset();
		}
		/** stop() と同じ。切断・記憶クリア・自動再接続解除。タブ間共有も解除する */
		reset() {
			const wasSecondary = this.bridgeLink?.currentRole === "secondary";
			this.releaseSharedBridge();
			this.stopWatchingAdvertisements();
			if (wasSecondary) {
				this.transport.disableAutoReconnect();
				return;
			}
			this.transport.reset();
		}
		/**
		* 選択中のデバイスのアドバタイズを監視する（接続していなくても受信できる）。
		* 受信は events.onAdvertisement / onEvent('onAdvertisement') と、プロファイルが解釈した
		* フィールド（INSOLE は `status`: バッテリー・取付位置・FW 版）の on() 配送で届く。
		* ブラウザやデバイスが対応していなければ false を返す。
		*/
		async watchAdvertisements() {
			const device = this.transport.device;
			if (!device || typeof device.watchAdvertisements !== "function") {
				this.debugLog("watchAdvertisements はこの環境では使えません");
				return false;
			}
			if (!this.advertisementListener) {
				this.advertisementListener = (event) => this.receiveAdvertisement(event);
				device.addEventListener("advertisementreceived", this.advertisementListener);
				this.advertisementDevice = device;
			}
			try {
				await device.watchAdvertisements();
				return true;
			} catch (error) {
				this.reportError(error);
				return false;
			}
		}
		/** アドバタイズの監視をやめる */
		stopWatchingAdvertisements() {
			if (this.advertisementDevice && this.advertisementListener) this.advertisementDevice.removeEventListener("advertisementreceived", this.advertisementListener);
			this.advertisementListener = null;
			this.advertisementDevice = null;
		}
		/** 最後に受信したアドバタイズをプロファイルが解釈した結果（INSOLE は `{ status }`）。未受信なら null */
		get lastAdvertisement() {
			return this.latestAdvertisement;
		}
		receiveAdvertisement(event) {
			this.emitLifecycle("onAdvertisement", event);
			const sample = this.profile.parseAdvertisement?.(event) ?? null;
			if (!sample) return;
			this.latestAdvertisement = sample;
			this.emitter.emit("ADVERTISEMENT", [sample]);
		}
		/** GATT 接続中なら true */
		isConnected() {
			return this.transport.isConnected();
		}
		/** 現在の接続状態（'disconnected' / 'connecting' / 'connected'） */
		get connectionState() {
			return this.transport.connectionState;
		}
	};
	//#endregion
	//#region src/device/legacy.ts
	var IRREGULAR_FIELD_NAMES = {
		ble_frequency: "gotBLEFrequency",
		lost_data: "lostData"
	};
	/** gotData オーバーライド中でも配送を止めないフィールド */
	var PASS_DURING_GOT_DATA = /* @__PURE__ */ new Set(["lost_data", "ble_frequency"]);
	/** フィールド名 → got* コールバック名（acc → gotAcc, converted_acc → gotConvertedAcc） */
	function fieldToGotName(field) {
		const irregular = IRREGULAR_FIELD_NAMES[field];
		if (irregular) return irregular;
		return "got" + field.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
	}
	/**
	* target に got* 配送を接続する。解除関数を返す。
	* target 省略時は ble 自身に接続する（型の上では any 相当になるため、
	* 型安全に使いたい場合は SDK ラッパー側で自身を渡すこと）。
	*
	* gotData の「オーバーライドされた」判定は attach 時点の値との比較。
	* SDK ラッパーが既定の noop gotData を持っていても gotData モードに
	* 誤爆しない（ユーザが差し替えたときだけ発動する）。
	*/
	function attachLegacyCallbacks(ble, target = ble) {
		const initialGotData = target.gotData;
		const isGotDataOverridden = () => typeof target.gotData === "function" && target.gotData !== initialGotData;
		const invoke = (name, args) => {
			const callback = target[name];
			if (typeof callback !== "function") return;
			try {
				callback.apply(target, args);
			} catch (error) {
				ble.reportError(error);
			}
		};
		const offStar = ble.emitter.on("*", (sample) => {
			const suppress = isGotDataOverridden();
			for (const field of Object.keys(sample)) {
				const value = sample[field];
				if (value === void 0) continue;
				if (suppress && !PASS_DURING_GOT_DATA.has(field)) continue;
				if (field === "lost_data") {
					const loss = value;
					invoke("lostData", [loss.serial, loss.prev]);
				} else invoke(fieldToGotName(field), [value]);
			}
		});
		const offRaw = ble.onRaw((uuid, data) => {
			if (!isGotDataOverridden()) return;
			invoke("gotData", [data, uuid]);
		});
		return () => {
			offStar();
			offRaw();
		};
	}
	//#endregion
	//#region src/csv.ts
	/** CSV 文字列をブラウザでダウンロードさせる（Node など document のない環境では throw） */
	function downloadCsv(csv, filename) {
		const doc = globalThis.document;
		if (!doc) throw new Error("downloadCsv: document is not available (browser only)");
		const blob = new Blob([csv], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = doc.createElement("a");
		a.href = url;
		a.download = filename;
		a.style.display = "none";
		doc.body.appendChild(a);
		a.click();
		setTimeout(() => {
			URL.revokeObjectURL(url);
			a.parentNode?.removeChild(a);
		}, 1e3);
	}
	//#endregion
	//#region src/fifo/protocol.ts
	/**
	* FIFO — ロスレス（欠損なし）センサーデータ収集（opt-in）。
	* プロトコルは INSOLE / CORE 共通（CORE は対応 FW が必要）。データパケットの中身だけがデバイスで違う。
	*
	* リアルタイムストリーミングは BLE の取りこぼしでパケットが欠落しうる。FIFO 収集は
	* FW のリングバッファに蓄積されたサンプルを「シリアル番号を指定して取り出す」
	* プル型プロトコルで回収し、通信で落ちたぶんは次のポーリングで再要求する。
	*
	* BLE プロトコル（コマンドは DEVICE_INFORMATION に write、応答は SENSOR_VALUES notify）:
	*   [0x0D, mode]                      読み取りモード変更（0x02 = FIFO）
	*   [0x0B, 0x01]                      現在シリアル取得 → 0x35 0x01 serial(2) watermark(1) accumulated(2)
	*   [0x0B, 0x02, <30×(sMSB,sLSB,cMSB,cLSB)>]  データ範囲要求（30組までpad）
	*   [0x0B, 0x03] / 0x04 / 0x06        全消去 / モニタ開始 / モニタ停止（ACK: 0x35 0x03/04/06）
	*   no-data 応答:  0x35 0x02 start(2) count(2)
	*   データパケット: 0x36 serial(2) ts(5) + サンプル。どちらも 104 bytes で、先頭のサンプルほど新しい
	*     INSOLE: 4×24B(gyro3,acc3,press6)
	*     CORE:   8×12B(gyro3,acc3)。圧力なし
	*
	* 注意: FIFO モードはジャイロ・加速度（INSOLE は 6ch 圧力も）のみでクォータニオンを含まない。
	*
	* 単位換算: 生値は device information に設定したレンジの値なので、そのレンジで換算する
	* （{@link fifoRangeFromDeviceInformation}。読めなければ ±16G / ±2000dps）。
	* gyro[dps] は LSM6DSOX のデータシート代表感度（±2000dps で 70 mdps/LSB = レンジ × 0.035 mdps）を使う。
	* 理想 Q15（/32768*レンジ）とは意図的に係数 1.14688 倍だけ異なる。acc[G] の /32768*レンジ は
	* データシート感度（±16G で 0.488 mg/LSB）と一致するのでそのまま。
	*
	* フレーム間隔: decodeFifoPacket() が返すサンプルの `t` は実測 IMU
	* ODR ≈208Hz（FRAME_INTERVAL_MS≈4.8077ms/frame）で計算する。packetToCsvRows() の
	* timestamp 文字列（ミリ秒3桁）だけは既存の記録データと揃えるため、意図的に
	* LEGACY_CSV_FRAME_INTERVAL_MS（5ms/frame）のまま据え置く。CSV の timestamp から
	* dt を逆算しないこと。
	*/
	var UINT16_MAX = 65536;
	/** FW 側リングバッファの保持件数の目安。これ以上追従が遅れると古いサンプルが上書きされる。 */
	var FIFO_RING_BUFFER_CAPACITY = 1500;
	/** INSOLE: 24B（gyro3, acc3, press6）× 4 サンプル */
	var INSOLE_FIFO_LAYOUT = Object.freeze({
		samples: 4,
		sampleSize: 24,
		hasPressure: true
	});
	/** CORE: 12B（gyro3, acc3）× 8 サンプル */
	var CORE_FIFO_LAYOUT = Object.freeze({
		samples: 8,
		sampleSize: 12,
		hasPressure: false
	});
	/** プロファイル種別（`'insole'` / `'core'`）→ レイアウト。core 以外は INSOLE として扱う。 */
	function fifoLayoutFor(kind) {
		return kind === "core" ? CORE_FIFO_LAYOUT : INSOLE_FIFO_LAYOUT;
	}
	/** 1 フレームぶんの時間 [ms]（≈4.8077ms）。{@link FifoSample.t} の算出に使う。 */
	var FIFO_FRAME_INTERVAL_MS = 1e3 / 208;
	/** CORE の {@link rawStoreToCSV} が出力する CSV の 1 行目（列名）。圧力の列はない。 */
	var FIFO_CSV_HEADER_CORE = "serial_number,timestamp,gyro_x[dps],gyro_y[dps],gyro_z[dps],acc_x[G],acc_y[G],acc_z[G]";
	/** INSOLE の {@link rawStoreToCSV} が出力する CSV の 1 行目（列名）。 */
	var FIFO_CSV_HEADER = FIFO_CSV_HEADER_CORE + ",press1[N],press2[N],press3[N],press4[N],press5[N],press6[N]";
	function binToInt(msb, lsb) {
		let v = (msb << 8) + lsb;
		if (v >= 32768) v -= 65536;
		return v;
	}
	/** device information を読めないときのレンジ。 */
	var FIFO_DEFAULT_RANGE = Object.freeze({
		acc: 16,
		gyro: DEFAULT_GYRO_RANGE
	});
	/**
	* device information のレンジ設定（index 0..3）→ 物理値。未取得・範囲外は {@link FIFO_DEFAULT_RANGE}。
	*/
	function fifoRangeFromDeviceInformation(info) {
		return imuRangeFromSettings(info?.range);
	}
	DEFAULT_GYRO_RANGE * GYRO_DPS_PER_LSB_PER_RANGE;
	/** 加速度の生値（MSB,LSB）→ G。`range` は加速度レンジ [G]（既定 ±16G）。 */
	function accToG(msb, lsb, range = FIFO_DEFAULT_RANGE.acc) {
		return binToInt(msb, lsb) / 32768 * range;
	}
	/** ジャイロの生値（MSB,LSB）→ dps。`range` は角速度レンジ [dps]（既定 ±2000dps）。 */
	function gyroToDps(msb, lsb, range = FIFO_DEFAULT_RANGE.gyro) {
		return gyroRawToDps(binToInt(msb, lsb), range);
	}
	/** 圧力生値(ADC uint16) → N（固定校正多項式。n は 1..6） */
	function pressureToN(x, n) {
		let y;
		switch (n) {
			case 1:
				y = 631278e-16 * x ** 4 - 2.33093e-7 * x ** 3 + 327825e-9 * x ** 2 - .163373 * x + 22.5012;
				break;
			case 2:
				y = 665168e-16 * x ** 4 - 2.10741e-7 * x ** 3 + 231937e-9 * x ** 2 - .0710366 * x + 6.97927;
				break;
			case 3:
				y = 107646e-15 * x ** 4 - 3.85112e-7 * x ** 3 + 502384e-9 * x ** 2 - .237328 * x + 31.8015;
				break;
			case 4:
				y = 591156e-16 * x ** 4 - 1.81045e-7 * x ** 3 + 186644e-9 * x ** 2 - .0446178 * x + 3.10811;
				break;
			case 5:
				y = 532573e-16 * x ** 4 - 1.68515e-7 * x ** 3 + 179518e-9 * x ** 2 - .0466859 * x + 3.71484;
				break;
			case 6:
				y = 444324e-16 * x ** 4 - 1.09728e-7 * x ** 3 + 890389e-10 * x ** 2 + .00382816 * x - 4.4658;
				break;
			default: y = 0;
		}
		return y < 0 ? 0 : y;
	}
	/** start_exclusive の次から end_inclusive まで進んだ個数（wrap-around 対応） */
	function serialDistance(startExclusive, endInclusive) {
		return ((endInclusive - startExclusive) % UINT16_MAX + UINT16_MAX) % UINT16_MAX;
	}
	/** `startSerial` から `requestSize` 件ぶんの連番シリアル（wrap-around 対応）を並べる。 */
	function calcExpectedSerials(startSerial, requestSize) {
		const out = [];
		for (let i = 0; i < requestSize; i++) out.push((startSerial + i) % UINT16_MAX);
		return out;
	}
	/** (start,count) の配列を要求順の serial 配列に展開 */
	function expandRequestsToList(reqs) {
		const out = [];
		for (const [start, count] of reqs) for (let i = 0; i < count; i++) out.push((start + i) % UINT16_MAX);
		return out;
	}
	/** 欠損シリアルの集合を連番の塊にまとめる 例: {10,12,40,41,42} → [[10,1],[12,1],[40,3]] */
	function buildRequestsFromSerials(serials) {
		const sorted = Array.from(serials).sort((a, b) => a - b);
		if (sorted.length === 0) return [];
		const out = [];
		let runStart = sorted[0];
		let runLen = 1;
		let prev = sorted[0];
		for (let i = 1; i < sorted.length; i++) {
			const sn = sorted[i];
			if (sn === (prev + 1) % 65536) runLen += 1;
			else {
				out.push([runStart, runLen]);
				runStart = sn;
				runLen = 1;
			}
			prev = sn;
		}
		out.push([runStart, runLen]);
		return out;
	}
	/**
	* データ要求パケット [0x0B,0x02, 30組...] を作成（30組に満たない分は 0 埋め）。
	* FW は固定 30 スロット（2 + 30×4 = 122 bytes）前提で読むため、超過は不正パケット。
	*/
	function createGetSensorDataRequest(pairs) {
		if (pairs.length > 30) throw new RangeError(`createGetSensorDataRequest: too many ranges (${pairs.length} > 30)`);
		const req = [11, 2];
		for (const [serial, count] of pairs) req.push(serial >> 8 & 255, serial & 255, count >> 8 & 255, count & 255);
		for (let i = 0; i < 30 - pairs.length; i++) req.push(0, 0, 0, 0);
		return Uint8Array.from(req);
	}
	/** no-data 応答 (0x35 0x02 start(2) count(2)) → [start, count] または null */
	function parseNoDataResponse(dv) {
		if (dv.byteLength < 2 || dv.getUint8(0) !== 53 || dv.getUint8(1) !== 2) return null;
		return [dv.byteLength >= 4 ? dv.getUint16(2) : 0, dv.byteLength >= 6 ? dv.getUint16(4) : 0];
	}
	/** データパケットならシリアル番号、そうでなければ null */
	function extractSerialIfSensorPacket(dv) {
		if (dv.byteLength < 3 || dv.getUint8(0) !== 54) return null;
		return dv.getUint16(1);
	}
	/** 現在シリアル応答 → {serial, watermark, accumulated} または null */
	function parseCurrentSerial(dv) {
		if (dv.byteLength < 7 || dv.getUint8(0) !== 53 || dv.getUint8(1) !== 1) return null;
		return {
			serial: dv.getUint16(2),
			watermark: dv.getUint8(4),
			accumulated: dv.getUint16(5)
		};
	}
	function pad2(n) {
		return String(n).padStart(2, "0");
	}
	function pad3(n) {
		return String(n).padStart(3, "0");
	}
	/** HH:MM:SS:mmm 形式（オフセット加算・繰り上がり対応） */
	function timestampToStr(hour, minute, second, ms, offsetMs) {
		ms += offsetMs || 0;
		while (ms >= 1e3) {
			ms -= 1e3;
			second += 1;
		}
		while (second >= 60) {
			second -= 60;
			minute += 1;
		}
		while (minute >= 60) {
			minute -= 60;
			hour += 1;
		}
		while (hour >= 24) hour -= 24;
		return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}:${pad3(ms)}`;
	}
	/** パケット基準タイムスタンプ（ms）。ソート用（wrap-around に依存しない） */
	function extractTimestampMs(dv) {
		const h = dv.getUint8(3);
		const m = dv.getUint8(4);
		const s = dv.getUint8(5);
		const ms = dv.getUint16(6);
		return (h * 3600 + m * 60 + s) * 1e3 + ms;
	}
	function readFrame(dv, i, layout, range) {
		const o = i * layout.sampleSize + 8;
		const gyro = (k) => gyroToDps(dv.getUint8(o + k), dv.getUint8(o + k + 1), range.gyro);
		const acc = (k) => accToG(dv.getUint8(o + k), dv.getUint8(o + k + 1), range.acc);
		return {
			gyro: [
				gyro(0),
				gyro(2),
				gyro(4)
			],
			acc: [
				acc(6),
				acc(8),
				acc(10)
			],
			press: layout.hasPressure ? [
				dv.getUint16(o + 12),
				dv.getUint16(o + 14),
				dv.getUint16(o + 16),
				dv.getUint16(o + 18),
				dv.getUint16(o + 20),
				dv.getUint16(o + 22)
			] : null
		};
	}
	/**
	* 1データパケット(0x36) → サンプル配列（ライブ可視化用）。`kind` はプロファイル種別で、
	* INSOLE は 4、CORE は 8 フレーム。`range` は device information のレンジ（{@link fifoRangeFromDeviceInformation}）。
	* フレームは古い順（バイト列の末尾のフレームが基準、以降 +FIFO_FRAME_INTERVAL_MS）。出力もその順。
	*/
	function decodeFifoPacket(dv, kind = "insole", range = FIFO_DEFAULT_RANGE) {
		const layout = fifoLayoutFor(kind);
		const serial = dv.getUint16(1);
		const baseMs = extractTimestampMs(dv);
		const samples = [];
		for (let i = layout.samples - 1; i >= 0; i--) {
			const packet_number = layout.samples - 1 - i;
			const f = readFrame(dv, i, layout, range);
			samples.push({
				serial_number: serial,
				packet_number,
				t: baseMs + packet_number * FIFO_FRAME_INTERVAL_MS,
				converted_gyro: {
					x: f.gyro[0],
					y: f.gyro[1],
					z: f.gyro[2]
				},
				converted_acc: {
					x: f.acc[0],
					y: f.acc[1],
					z: f.acc[2]
				},
				press: f.press ? {
					values: f.press,
					serial_number: serial,
					packet_number
				} : null
			});
		}
		return {
			serial,
			timestamp: baseMs,
			samples
		};
	}
	function f2(v) {
		return v.toFixed(2).padStart(8);
	}
	function f4(v) {
		return v.toFixed(4).padStart(8);
	}
	/**
	* 1データパケット → CSV の行（INSOLE は 4 行、CORE は 8 行で圧力の列なし）。timestamp 列は意図的に
	* FIFO_LEGACY_CSV_FRAME_INTERVAL_MS（5ms/frame）のまま据え置く（冒頭コメント参照）。
	*/
	function packetToCsvRows(dv, calibrations = null, kind = "insole", range = FIFO_DEFAULT_RANGE) {
		const layout = fifoLayoutFor(kind);
		const toN = (raw, i) => calibrations ? pressureToNewton(raw, calibrations[i]) : pressureToN(raw, i + 1);
		const serial = dv.getUint16(1);
		const h = dv.getUint8(3);
		const m = dv.getUint8(4);
		const s = dv.getUint8(5);
		const ms = dv.getUint16(6);
		const rows = [];
		for (let i = layout.samples - 1; i >= 0; i--) {
			const offsetMs = (layout.samples - 1 - i) * 5;
			const f = readFrame(dv, i, layout, range);
			const cells = [
				String(serial),
				timestampToStr(h, m, s, ms, offsetMs),
				f2(f.gyro[0]),
				f2(f.gyro[1]),
				f2(f.gyro[2]),
				f4(f.acc[0]),
				f4(f.acc[1]),
				f4(f.acc[2])
			];
			if (f.press) cells.push(...f.press.map((raw, ch) => f4(toN(raw, ch))));
			rows.push(cells.join(", "));
		}
		return rows;
	}
	/**
	* 収集した raw ストア（Map<serial, DataView>）を timestamp 順に並べて CSV 文字列化。
	* `kind` はプロファイル種別で、CORE は圧力の列がない {@link FIFO_CSV_HEADER_CORE} になる。
	* `range` は device information のレンジ（{@link fifoRangeFromDeviceInformation}）。
	*/
	function rawStoreToCSV(rawStore, calibrations = null, kind = "insole", range = FIFO_DEFAULT_RANGE) {
		const entries = Array.from(rawStore.values());
		entries.sort((a, b) => extractTimestampMs(a) - extractTimestampMs(b));
		const lines = [fifoLayoutFor(kind).hasPressure ? FIFO_CSV_HEADER : FIFO_CSV_HEADER_CORE];
		for (const dv of entries) {
			if (dv.byteLength < 1 || dv.getUint8(0) !== 54) continue;
			for (const row of packetToCsvRows(dv, calibrations, kind, range)) lines.push(row);
		}
		return lines.join("\n") + "\n";
	}
	//#endregion
	//#region src/fifo/state.ts
	/**
	* FIFO 収集ループの状態機械。
	*
	* - NotifyQueue   … notify を promise で待てるキュー（応答待ちの同期化）
	* - FifoLoopState … 1 収録ぶんの回収済みデータ・再要求キュー・ロス計上
	* - DrainBudget   … stop() 後の回収フェーズの idle 予算
	*
	* BLE は一切触らない。純粋にロジックだけを持ち、recorder.ts が組み合わせて使う。
	*/
	/** notify を promise で待てるようにするキュー。FIFO の同期的な応答待ちに使う。 */
	var NotifyQueue = class {
		items = [];
		waiters = [];
		/** 受信した notify を積む。待機中の {@link wait} があれば直接渡す。 */
		push(data) {
			const w = this.waiters.shift();
			if (w) w(data);
			else this.items.push(data);
		}
		/** 未処理の受信を全部捨てる（モード切替直後の残骸除去などに使う）。 */
		drain() {
			this.items.length = 0;
		}
		/** timeout(ms) 待って先頭を取り出す。タイムアウトで null */
		wait(timeoutMs) {
			if (this.items.length) return Promise.resolve(this.items.shift());
			return new Promise((resolve) => {
				let settled = false;
				const done = (v) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					const i = this.waiters.indexOf(done);
					if (i >= 0) this.waiters.splice(i, 1);
					resolve(v);
				};
				const timer = setTimeout(() => done(null), timeoutMs);
				this.waiters.push(done);
			});
		}
	};
	/** ポーリングループ 1 収録ぶんの状態（回収済みデータ・再要求キュー・ロス計上）。 */
	var FifoLoopState = class {
		/** 最後まで要求し終えたシリアル番号。null は「未同期（次ポーリングで再アンカー）」 */
		lastSerial = null;
		/** 次ループで再要求する範囲（BLE で取りこぼしたぶん） */
		carryOver = [];
		/** 回収済みの生パケット。key はシリアル番号 */
		rawStore = /* @__PURE__ */ new Map();
		/** 回復不能に失われた累計シリアル数 */
		dropped = 0;
		/** 未通知の回復不能ロスイベント（呼び出し側が drain） */
		lossEvents = [];
		/** lastSerial=null が「再同期由来」か（初回 start 直後と区別） */
		resyncPending = false;
		/** 収録スパンの起点シリアル */
		firstStoredSerial = null;
		/** firstStoredSerial からの最大距離（収録スパン-1） */
		storedSpanMax = 0;
		/**
		* rawStore へ格納したシリアルの収録スパンを記録する。firstStoredSerial は
		* 「スパンの起点（＝これまでで最小）」であり、より手前のシリアルが来たら巻き戻す。
		* これをしないと serialDistance(起点, 手前) が ~65536 になり storedSpanMax が爆発し、
		* finalizePendingLoss が幻の巨大欠損を計上する（収録アークは半周 < 32768 前提）。
		*/
		noteStored(serial) {
			if (this.firstStoredSerial === null) {
				this.firstStoredSerial = serial;
				this.storedSpanMax = 0;
				return;
			}
			const fwd = serialDistance(this.firstStoredSerial, serial);
			const bwd = serialDistance(serial, this.firstStoredSerial);
			if (bwd < fwd) {
				this.firstStoredSerial = serial;
				this.storedSpanMax += bwd;
			} else if (fwd > this.storedSpanMax) this.storedSpanMax = fwd;
		}
		/**
		* 収録スパンの終端を、格納の有無に関わらず serial まで延ばす（stop 時の catch-up 用）。
		* 延ばさないと回収できなかった末尾が計上対象外になり「黙った切り捨て」になる。
		* modular 距離で判定し、半周超は異常値として無視する。
		*/
		noteSpanTarget(serial) {
			if (this.firstStoredSerial === null) return;
			const fwd = serialDistance(this.firstStoredSerial, serial);
			if (fwd > 32768) return;
			if (fwd > this.storedSpanMax) this.storedSpanMax = fwd;
		}
		/**
		* 収集終了時の最終計上。スパン内で「格納も回復不能計上もされていない」シリアルを
		* dropped に計上する。不変条件: スパン内シリアル数 = rawStore.size + dropped。
		*
		* @returns 今回追加で計上したロス数
		*/
		finalizePendingLoss() {
			if (this.firstStoredSerial === null) return 0;
			const pending = this.storedSpanMax + 1 - this.rawStore.size - this.dropped;
			if (pending <= 0) return 0;
			this.dropped += pending;
			this.lossEvents.push({
				reason: "stopped_pending",
				dropped: pending
			});
			return pending;
		}
		/** 新規リクエストの [startSerial, requestSize] を計算 */
		calcRequestRange(currentSerial, accumulatedCount, maxNewRequest) {
			if (this.lastSerial === null) {
				const requestSize = Math.min(accumulatedCount, maxNewRequest);
				if (this.resyncPending) {
					const lost = Math.max(0, accumulatedCount - requestSize);
					if (lost > 0) {
						this.dropped += lost;
						this.lossEvents.push({
							reason: "resync_backlog",
							dropped: lost
						});
					}
					this.resyncPending = false;
				}
				return [requestSize > 0 ? ((currentSerial - (requestSize - 1)) % UINT16_MAX + UINT16_MAX) % UINT16_MAX : 0, requestSize];
			}
			let need = serialDistance(this.lastSerial, currentSerial);
			if (need > 1500) {
				const skip = need - FIFO_RING_BUFFER_CAPACITY;
				this.lastSerial = (this.lastSerial + skip) % UINT16_MAX;
				this.carryOver = [];
				this.dropped += skip;
				this.lossEvents.push({
					reason: "ring_overflow",
					dropped: skip
				});
				need = serialDistance(this.lastSerial, currentSerial);
			}
			const requestSize = Math.min(need, maxNewRequest);
			return [(this.lastSerial + 1) % UINT16_MAX, requestSize];
		}
		/** レスポンス後に lastSerial と carryOver を更新。戻り値はログ用 */
		updateAfterResponse(bleLoss, newNoData, startSerial, requestSize) {
			if (bleLoss.size > 0) {
				this.carryOver.push(...buildRequestsFromSerials(bleLoss));
				const totalPending = this.carryOver.reduce((sum, [, c]) => sum + c, 0);
				if (totalPending > 100) {
					this.dropped += totalPending;
					this.lossEvents.push({
						reason: "carryover_overflow",
						dropped: totalPending
					});
					this.carryOver = [];
					this.lastSerial = null;
					this.resyncPending = true;
					return "resync";
				}
			}
			if (newNoData.size > 0) {
				this.lastSerial = null;
				this.resyncPending = true;
			} else if (requestSize > 0) this.lastSerial = (startSerial + requestSize - 1) % UINT16_MAX;
			return "ok";
		}
	};
	/**
	* 「無音が budgetMs 続いたら諦める」予算。データが届いている間は noteProgress() で
	* 期限が延び、hardDeadline（budgetMs × FIFO_CATCHUP_MAX_BUDGET_FACTOR）で必ず打ち切る。
	*/
	var DrainBudget = class DrainBudget {
		/** 無音を許容する時間 [ms] */
		budgetMs;
		/** 現在の期限（{@link noteProgress} で延びる） */
		deadline;
		/** 延長しても超えない絶対期限 */
		hardDeadline;
		constructor(budgetMs, now = Date.now()) {
			this.budgetMs = Math.max(0, budgetMs);
			this.deadline = now + this.budgetMs;
			this.hardDeadline = now + this.budgetMs * 10;
		}
		/** 絶対期限を「延長なしの予算」として扱う */
		static fromDeadline(deadline, now = Date.now()) {
			const b = new DrainBudget(Math.max(0, deadline - now), now);
			b.hardDeadline = deadline;
			return b;
		}
		/** 数値なら絶対期限として、DrainBudget ならそのまま受け取る。 */
		static coerce(budgetOrDeadline) {
			return typeof budgetOrDeadline === "number" ? DrainBudget.fromDeadline(budgetOrDeadline) : budgetOrDeadline;
		}
		/** 予算切れなら true。 */
		get expired() {
			return this.remainingMs() <= 0;
		}
		/** 残り時間 [ms]。期限切れなら 0。 */
		remainingMs() {
			return Math.max(0, Math.min(this.deadline, this.hardDeadline) - Date.now());
		}
		/** データが届いたので期限を延ばす（hardDeadline は超えない）。 */
		noteProgress() {
			this.deadline = Math.min(Date.now() + this.budgetMs, this.hardDeadline);
		}
	};
	//#endregion
	//#region src/fifo/recorder.ts
	var DEFAULT_TIMING = {
		pollingIntervalMs: 200,
		currentSerialTimeoutMs: 50,
		oneShotTimeoutMs: 5e3,
		oneShotIdleTimeoutMs: 400,
		commandAckTimeoutMs: 300,
		modeSwitchDelayMs: 100,
		fifoModeSettleMs: 200,
		retryIntervalMs: 1e3
	};
	/**
	* FIFO（ロスレス）収集。begin() 済みの OrpheCoreInsole（insole / core）を渡して使う。
	* core は FIFO 対応 FW でのみ動作する（未対応 FW では start() が false を返す）。
	* 収録中は SENSOR_VALUES の notify を setNotifySink で横取りするため、
	* リアルタイム配信（press/acc 等）は一時停止する。
	*
	*   const fifo = new FifoRecorder(ble);
	*   fifo.onSamples = (deviceId, samples) => { ... };
	*   await fifo.start();
	*   ...
	*   await fifo.stop();
	*   fifo.download('capture.csv');
	*/
	var FifoRecorder = class {
		/** 収集対象のデバイス（begin() 済みの OrpheCoreInsole） */
		ble;
		/** 回復不能な欠損が出た時点で自動停止するか */
		stopOnLoss;
		/**
		* ポーリングループの内部状態（回収済みデータ・ロス計上）
		*
		* @internal
		*/
		state = new FifoLoopState();
		/** 現在の追従遅れ（未取得シリアル数） */
		lag = 0;
		/** パケットをデコードするたびに呼ばれる（ライブ可視化用） */
		onSamples = null;
		/** ポーリングごとの進捗通知 */
		onProgress = null;
		/** 期待件数と受信件数がズレたときの内訳通知 */
		onAnomaly = null;
		/** 回復不能な欠損が確定したときの通知 */
		onDataLoss = null;
		/** 収録終了時のサマリ通知 */
		onStopped = null;
		/** 収集中に起きた例外の通知 */
		onError = null;
		options;
		timing;
		wait;
		queue = new NotifyQueue();
		running = false;
		starting = false;
		loopPromise = null;
		restoreMode = null;
		removeSink = null;
		tornDown = false;
		autoStopped = false;
		lastCurrentSerial = null;
		captureId = 0;
		/** start() 時点の device information のレンジ。デコードと CSV の換算に使う */
		range = FIFO_DEFAULT_RANGE;
		constructor(ble, options = {}) {
			this.ble = ble;
			this.options = options;
			this.stopOnLoss = options.stopOnLoss ?? false;
			this.timing = {
				...DEFAULT_TIMING,
				...options.timing
			};
			this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		}
		/** デバイス識別子。 */
		get deviceId() {
			return this.ble.id;
		}
		/** 回収済みパケット数。 */
		get collectedCount() {
			return this.state.rawStore.size;
		}
		/** 回復不能に失われた累計シリアル数（0 なら欠損なし） */
		get droppedCount() {
			return this.state.dropped;
		}
		/** 収録中なら true。 */
		get isRunning() {
			return this.running;
		}
		/**
		* 収集済みデータと損失カウントを捨てて初期状態へ戻す。
		* 収録中は何も変更しない（stop() してから呼ぶこと）。
		* 直前までに発行した {@link FifoCheckpoint} は無効になる。
		*/
		reset() {
			if (this.running) return;
			this.state = new FifoLoopState();
			this.captureId += 1;
			this.lag = 0;
			this.lastCurrentSerial = null;
		}
		/**
		* FIFO 内部の要求境界を記録する。到着時刻でなく device serial 範囲で
		* 後続区間の完全性を判定するため、preview 後の正式計測開始時に使う。
		*/
		createCheckpoint() {
			return {
				captureId: this.captureId,
				serial: this.state.lastSerial,
				dropped: this.state.dropped,
				collected: this.state.rawStore.size
			};
		}
		/**
		* checkpoint 直後から現在の要求済み serial までを rawStore で再集計する。
		* 遅延・再要求で到着順が前後しても、drain 後の最終欠損を正しく返す。
		*/
		summarizeSince(checkpoint) {
			const start = checkpoint && Number.isInteger(checkpoint.serial) ? checkpoint.serial : null;
			const end = this.state.lastSerial;
			if (!(checkpoint && checkpoint.captureId === this.captureId) || start === null || !Number.isInteger(end)) return {
				available: false,
				first: null,
				last: null,
				expected: 0,
				received: 0,
				missing: 0,
				missingRate: 0,
				dropped: Math.max(0, this.state.dropped - Number(checkpoint?.dropped ?? 0)),
				checkpoint
			};
			const expected = serialDistance(start, end);
			const received = this.serialsSince(checkpoint).length;
			const missing = Math.max(0, expected - received);
			return {
				available: true,
				first: expected > 0 ? (start + 1) % UINT16_MAX : null,
				last: end,
				expected,
				received,
				missing,
				missingRate: expected > 0 ? missing / expected : 0,
				dropped: missing,
				reportedDroppedDelta: Math.max(0, this.state.dropped - Number(checkpoint.dropped ?? 0)),
				checkpoint
			};
		}
		/** checkpoint 範囲に含まれる回収済み device serial を返す */
		serialsSince(checkpoint) {
			const start = checkpoint && Number.isInteger(checkpoint.serial) ? checkpoint.serial : null;
			const end = this.state.lastSerial;
			if (!checkpoint || checkpoint.captureId !== this.captureId || start === null || !Number.isInteger(end)) return [];
			const expected = serialDistance(start, end);
			const serials = [];
			for (const serial of this.state.rawStore.keys()) {
				const distance = serialDistance(start, serial);
				if (distance > 0 && distance <= expected) serials.push(serial);
			}
			return serials;
		}
		write(bytes) {
			return this.ble.transport.write("DEVICE_INFORMATION", bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
		}
		async setReadMode(mode) {
			await this.write([13, mode]);
			await this.wait(this.timing.modeSwitchDelayMs);
		}
		/** ACK 応答 (0x35 sub) を待つコマンド */
		async commandExpectAck(sub) {
			this.queue.drain();
			await this.write([11, sub]);
			const dv = await this.queue.wait(this.timing.commandAckTimeoutMs);
			return !!(dv && dv.byteLength >= 2 && dv.getUint8(0) === 53 && dv.getUint8(1) === sub);
		}
		async getCurrentSerial() {
			this.queue.drain();
			await this.write([11, 1]);
			const dv = await this.queue.wait(this.timing.currentSerialTimeoutMs);
			return dv ? parseCurrentSerial(dv) : null;
		}
		async retry(fn, retries = 10) {
			for (let i = 0; i < retries; i++) {
				if (await fn()) return true;
				await this.wait(this.timing.retryIntervalMs);
			}
			return false;
		}
		async retryValue(fn, retries = 10) {
			for (let i = 0; i < retries; i++) {
				const v = await fn();
				if (v !== null && v !== void 0) return v;
				await this.wait(1);
			}
			return null;
		}
		/**
		* FIFO 収集を開始する。SENSOR_VALUES 通知は begin() で開始済みであること。
		* @returns 準備に成功して収集を開始できたら true
		*/
		async start() {
			if (this.running || this.starting) return this.running;
			this.starting = true;
			try {
				if (this.loopPromise) try {
					await this.loopPromise;
				} catch {}
			} finally {
				this.starting = false;
			}
			if (!this.ble.isConnected()) {
				this.reportError(/* @__PURE__ */ new Error("FifoRecorder.start(): insole is not connected"));
				return false;
			}
			const modes = this.ble.availableModes;
			if (modes && modes.length > 0 && !modes.some((mode) => mode.id === "FIFO")) {
				this.reportError(new TransportError("UNSUPPORTED_MODE", "FifoRecorder.start(): FIFO is not available on this firmware"));
				return false;
			}
			this.state = new FifoLoopState();
			this.captureId += 1;
			this.range = fifoRangeFromDeviceInformation(this.ble.profile.device_information);
			this.restoreMode = this.options.restoreMode !== void 0 ? this.options.restoreMode : this.ble.profile.streaming_mode ?? (this.ble.profile.kind === "core" ? 1 : 4);
			try {
				this.removeSink = this.ble.setNotifySink("SENSOR_VALUES", (dv) => this.queue.push(dv));
			} catch (error) {
				this.reportError(error);
				return false;
			}
			try {
				await this.setReadMode(2);
				await this.wait(this.timing.fifoModeSettleMs);
				this.queue.drain();
				if (!await this.prepare()) {
					this.reportError(/* @__PURE__ */ new Error("FifoRecorder.start(): failed to prepare FIFO collection"));
					await this.teardown();
					return false;
				}
			} catch (error) {
				this.reportError(error);
				await this.teardown();
				return false;
			}
			this.running = true;
			this.tornDown = false;
			this.autoStopped = false;
			this.loopPromise = this.runLoopWrapped();
			return true;
		}
		async runLoopWrapped() {
			let drainRecovered = 0;
			let catchupRecovered = 0;
			try {
				await this.runLoop();
				const drainTimeoutMs = this.options.drainTimeoutMs ?? 3e3;
				if (!this.autoStopped && drainTimeoutMs > 0 && this.ble.isConnected()) {
					const budget = new DrainBudget(drainTimeoutMs);
					catchupRecovered = await this.catchUpLoop(await this.resolveCatchUpTarget(), budget);
					drainRecovered = await this.drainLoop(budget);
				}
			} catch (error) {
				this.reportError(error);
			} finally {
				const pending = this.state.finalizePendingLoss();
				if (pending > 0 && this.onDataLoss) this.safe(() => this.onDataLoss({
					reason: "stopped_pending",
					dropped: pending,
					cumulative: this.state.dropped,
					currentSerial: this.lastCurrentSerial
				}));
				this.state.lossEvents.length = 0;
				await this.teardownOnce();
				if (this.onStopped) this.safe(() => this.onStopped({
					reason: this.autoStopped ? "loss" : "manual",
					dropped: this.state.dropped,
					collected: this.state.rawStore.size,
					drainRecovered,
					catchupRecovered
				}));
			}
		}
		async resolveCatchUpTarget() {
			try {
				const current = await this.retryValue(() => this.getCurrentSerial(), 3);
				if (current && Number.isInteger(current.serial)) {
					this.lastCurrentSerial = current.serial;
					return current.serial;
				}
			} catch {}
			return Number.isInteger(this.lastCurrentSerial) ? this.lastCurrentSerial : null;
		}
		async catchUpLoop(frozenTarget, budget) {
			const state = this.state;
			if (!Number.isInteger(frozenTarget)) return 0;
			if (state.lastSerial === null) return 0;
			const backlog = serialDistance(state.lastSerial, frozenTarget);
			if (backlog === 0 || backlog > 32768) return 0;
			state.noteSpanTarget(frozenTarget);
			let recovered = 0;
			while (!budget.expired) {
				const anchor = state.lastSerial;
				const remaining = serialDistance(anchor, frozenTarget);
				if (remaining <= 0) break;
				const requestSize = Math.min(remaining, 200);
				const startSerial = (anchor + 1) % UINT16_MAX;
				const expectedSerials = new Set(calcExpectedSerials(startSerial, requestSize));
				this.queue.drain();
				await this.write(createGetSensorDataRequest([[startSerial, requestSize]]));
				const shotTimeout = Math.min(this.timing.oneShotTimeoutMs, budget.remainingMs());
				if (shotTimeout <= 0) break;
				const { received, noDataSerials } = await this.receiveResponses(expectedSerials, shotTimeout, this.timing.oneShotIdleTimeoutMs);
				state.lastSerial = (startSerial + requestSize - 1) % UINT16_MAX;
				this.classifyMissed(expectedSerials, received, noDataSerials);
				const stored = this.absorbReceived(received);
				recovered += stored;
				if (stored > 0) budget.noteProgress();
				this.flushLossEvents();
				if (this.onProgress) this.safe(() => this.onProgress({
					collected: state.rawStore.size,
					lastReceived: received.size,
					currentSerial: this.lastCurrentSerial,
					lag: serialDistance(state.lastSerial, frozenTarget) + state.carryOver.reduce((sum, [, c]) => sum + c, 0),
					dropped: state.dropped,
					draining: true,
					catchup: true
				}));
			}
			return recovered;
		}
		async drainLoop(budget) {
			const state = this.state;
			let recovered = 0;
			while (state.carryOver.length > 0 && !budget.expired) {
				const carryOverToSend = state.carryOver.slice(0, 30);
				state.carryOver = state.carryOver.slice(carryOverToSend.length);
				const expectedSerials = new Set(expandRequestsToList(carryOverToSend));
				if (expectedSerials.size === 0) continue;
				this.queue.drain();
				await this.write(createGetSensorDataRequest(carryOverToSend));
				const shotTimeout = Math.min(this.timing.oneShotTimeoutMs, budget.remainingMs());
				const { received, noDataSerials } = await this.receiveResponses(expectedSerials, shotTimeout, this.timing.oneShotIdleTimeoutMs);
				this.classifyMissed(expectedSerials, received, noDataSerials);
				const stored = this.absorbReceived(received);
				recovered += stored;
				if (stored > 0) budget.noteProgress();
				this.flushLossEvents();
				if (this.onProgress) this.safe(() => this.onProgress({
					collected: state.rawStore.size,
					lastReceived: received.size,
					currentSerial: this.lastCurrentSerial,
					lag: state.carryOver.reduce((sum, [, c]) => sum + c, 0),
					dropped: state.dropped,
					draining: true
				}));
			}
			return recovered;
		}
		classifyMissed(expectedSerials, received, noDataSerials) {
			const state = this.state;
			const missed = [...expectedSerials].filter((sn) => !received.has(sn));
			const bleLoss = new Set(missed.filter((sn) => !noDataSerials.has(sn)));
			const confirmedLost = missed.filter((sn) => noDataSerials.has(sn));
			if (confirmedLost.length > 0) {
				state.dropped += confirmedLost.length;
				state.lossEvents.push({
					reason: "fw_nodata",
					dropped: confirmedLost.length
				});
			}
			if (bleLoss.size > 0) state.carryOver.push(...buildRequestsFromSerials(bleLoss));
		}
		absorbReceived(received) {
			const state = this.state;
			const decodedSamples = [];
			let stored = 0;
			for (const [sn, dv] of received) {
				if (state.rawStore.has(sn)) continue;
				state.rawStore.set(sn, dv);
				state.noteStored(sn);
				stored += 1;
				for (const s of decodeFifoPacket(dv, this.ble.profile.kind, this.range).samples) decodedSamples.push(s);
			}
			if (decodedSamples.length && this.onSamples) this.safe(() => this.onSamples(this.deviceId, decodedSamples));
			return stored;
		}
		flushLossEvents() {
			const state = this.state;
			if (state.lossEvents.length === 0) return;
			const events = state.lossEvents.splice(0);
			if (!this.onDataLoss) return;
			for (const ev of events) this.safe(() => this.onDataLoss({
				...ev,
				cumulative: state.dropped,
				currentSerial: this.lastCurrentSerial
			}));
		}
		async prepare() {
			if (!await this.retry(() => this.commandExpectAck(6))) return false;
			if (!await this.retry(() => this.commandExpectAck(3))) return false;
			if (!await this.retry(() => this.commandExpectAck(4))) return false;
			const delay = this.options.startupDelayMs ?? 1e3;
			if (delay > 0) await this.wait(delay);
			return true;
		}
		async runLoop() {
			const state = this.state;
			while (this.running) {
				const current = await this.retryValue(() => this.getCurrentSerial(), 10);
				if (!this.running) break;
				if (current === null) {
					await this.wait(this.timing.pollingIntervalMs);
					continue;
				}
				const { serial: currentSerial, accumulated: accumulatedCount } = current;
				this.lastCurrentSerial = currentSerial;
				this.lag = state.lastSerial === null ? accumulatedCount : serialDistance(state.lastSerial, currentSerial);
				let carryOverToSend = state.carryOver.slice(0, 30);
				const carryOverSerialCount = carryOverToSend.reduce((sum, [, c]) => sum + c, 0);
				const maxNewRequest = Math.max(0, 200 - carryOverSerialCount);
				const [startSerial, requestSize] = state.calcRequestRange(currentSerial, accumulatedCount, maxNewRequest);
				if (requestSize <= 0 && carryOverToSend.length === 0) {
					await this.wait(this.timing.pollingIntervalMs);
					continue;
				}
				if (requestSize > 0 && carryOverToSend.length >= 30) carryOverToSend = carryOverToSend.slice(0, 29);
				const requests = [];
				if (requestSize > 0) requests.push([startSerial, requestSize]);
				for (const co of carryOverToSend) requests.push(co);
				state.carryOver = state.carryOver.slice(carryOverToSend.length);
				if (requests.length === 0) {
					await this.wait(this.timing.pollingIntervalMs);
					continue;
				}
				const expectedSerials = new Set(expandRequestsToList(requests));
				const newSerials = new Set(calcExpectedSerials(startSerial, requestSize));
				this.queue.drain();
				await this.write(createGetSensorDataRequest(requests));
				const { received, noDataSerials } = await this.receiveResponses(expectedSerials, this.timing.oneShotTimeoutMs, this.timing.oneShotIdleTimeoutMs);
				const allMissed = [...expectedSerials].filter((sn) => !received.has(sn));
				const bleLoss = new Set(allMissed.filter((sn) => !noDataSerials.has(sn)));
				const confirmedLost = allMissed.filter((sn) => noDataSerials.has(sn));
				const newNoData = new Set([...noDataSerials].filter((sn) => newSerials.has(sn)));
				if (confirmedLost.length > 0) {
					state.dropped += confirmedLost.length;
					state.lossEvents.push({
						reason: "fw_nodata",
						dropped: confirmedLost.length
					});
				}
				if ((noDataSerials.size > 0 || allMissed.length > 0) && this.onAnomaly) this.safe(() => this.onAnomaly({
					startSerial,
					requestSize,
					currentSerial,
					received: received.size,
					expected: expectedSerials.size,
					noData: noDataSerials.size,
					bleLoss: bleLoss.size,
					confirmedLost: confirmedLost.length,
					newNoData: newNoData.size
				}));
				state.updateAfterResponse(bleLoss, newNoData, startSerial, requestSize);
				if (state.lossEvents.length > 0) {
					const events = state.lossEvents.splice(0);
					if (this.onDataLoss) for (const ev of events) this.safe(() => this.onDataLoss({
						...ev,
						cumulative: state.dropped,
						currentSerial
					}));
					if (this.stopOnLoss) {
						this.autoStopped = true;
						this.running = false;
					}
				}
				const decodedSamples = [];
				for (const [sn, dv] of received) {
					state.rawStore.set(sn, dv);
					state.noteStored(sn);
					for (const s of decodeFifoPacket(dv, this.ble.profile.kind, this.range).samples) decodedSamples.push(s);
				}
				if (decodedSamples.length && this.onSamples) this.safe(() => this.onSamples(this.deviceId, decodedSamples));
				if (this.onProgress) this.safe(() => this.onProgress({
					collected: state.rawStore.size,
					lastReceived: received.size,
					currentSerial,
					lag: this.lag,
					dropped: state.dropped
				}));
				await this.wait(this.timing.pollingIntervalMs);
			}
		}
		async receiveResponses(expectedSerials, timeoutMs, idleTimeoutMs) {
			const received = /* @__PURE__ */ new Map();
			const noDataSerials = /* @__PURE__ */ new Set();
			const totalExpected = expectedSerials.size;
			const deadline = Date.now() + timeoutMs;
			const idleMs = idleTimeoutMs ?? timeoutMs;
			let gotAny = false;
			while (received.size + noDataSerials.size < totalExpected) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				const waitMs = gotAny ? Math.min(remaining, idleMs) : remaining;
				const dv = await this.queue.wait(waitMs);
				if (dv === null) break;
				gotAny = true;
				const noData = parseNoDataResponse(dv);
				if (noData !== null) {
					const [ndStart, ndCount] = noData;
					for (let i = 0; i < ndCount; i++) noDataSerials.add((ndStart + i) % UINT16_MAX);
					continue;
				}
				const serial = extractSerialIfSensorPacket(dv);
				if (serial !== null && expectedSerials.has(serial) && dv.byteLength === 104) received.set(serial, dv);
			}
			return {
				received,
				noDataSerials
			};
		}
		/**
		* 収集を停止し、リアルタイムモードへ復帰する。
		* @returns 収集した raw ストア（serial → 104byte DataView）
		*/
		async stop() {
			if (!this.loopPromise) return this.state.rawStore;
			this.running = false;
			try {
				await this.loopPromise;
			} catch {}
			this.loopPromise = null;
			return this.state.rawStore;
		}
		async teardownOnce() {
			if (this.tornDown) return;
			this.tornDown = true;
			await this.teardown();
		}
		async teardown() {
			try {
				if (this.ble.isConnected()) {
					await this.retry(() => this.commandExpectAck(6), 3).catch(() => false);
					if (this.restoreMode !== null) {
						await this.setReadMode(this.restoreMode).catch(() => {});
						this.ble.profile.streaming_mode = this.restoreMode;
					}
				}
			} catch {} finally {
				this.removeSink?.();
				this.removeSink = null;
			}
		}
		/** 収集データを CSV 文字列にする（timestamp 昇順） */
		toCSV() {
			return rawStoreToCSV(this.state.rawStore, this.ble.profile.pressure_calibrations ?? null, this.ble.profile.kind, this.range);
		}
		/** ブラウザで CSV をダウンロードする */
		download(filename = "orphe-insole-fifo.csv") {
			downloadCsv(this.toCSV(), filename);
		}
		safe(fn) {
			try {
				fn();
			} catch (error) {
				this.reportError(error);
			}
		}
		reportError(error) {
			if (this.onError) try {
				this.onError(error);
				return;
			} catch {}
			this.ble.reportError(error);
		}
	};
	/** 歩行タイプの分類値 → 名称 */
	var GAIT_TYPES = Object.freeze([
		"none",
		"walk",
		"run",
		"stance"
	]);
	/** ストライド方向の分類値 → 名称 */
	var STRIDE_DIRECTIONS = Object.freeze([
		"none",
		"forward",
		"backward",
		"inside",
		"outside"
	]);
	var FOOT_STRIKE_MID_THRESHOLD = -3;
	var FOOT_STRIKE_FORE_THRESHOLD = 2;
	var PRONATION_AVERAGE = -9.4;
	var PRONATION_STD = 3.5;
	function sanitize(v) {
		if (Number.isNaN(v) || !Number.isFinite(v)) return null;
		return v;
	}
	function sanitizeNonNeg(v) {
		const s = sanitize(v);
		return s === null || s < 0 ? null : s;
	}
	/** 歩行タイプの分類値 → 名称（{@link GAIT_TYPES}）。範囲外は `'unknown'`。 */
	function gaitTypeToStr(v) {
		return v >= 0 && v < GAIT_TYPES.length ? GAIT_TYPES[v] : "unknown";
	}
	/** ストライド方向の分類値 → 名称（{@link STRIDE_DIRECTIONS}）。範囲外は `'unknown'`。 */
	function strideDirectionToStr(v) {
		return v >= 0 && v < STRIDE_DIRECTIONS.length ? STRIDE_DIRECTIONS[v] : "unknown";
	}
	/** 着地時の足角度（pronationX）から接地パターンを判定 */
	function footStrikeToStr(strikeAngle) {
		if (strikeAngle === null || strikeAngle === void 0) return "none";
		if (strikeAngle > FOOT_STRIKE_FORE_THRESHOLD) return "forefoot";
		if (strikeAngle > FOOT_STRIKE_MID_THRESHOLD) return "midfoot";
		return "heelStrike";
	}
	/** プロネーション角（pronationY）から種別を判定 */
	function pronationToStr(pronationY) {
		if (pronationY === null || pronationY === void 0) return "none";
		const ave = PRONATION_AVERAGE;
		const std = PRONATION_STD;
		if (pronationY >= -12.9 && pronationY <= -5.9) return "neutral";
		if (pronationY > -5.9 && pronationY <= 1.0999999999999996) return "over";
		if (pronationY > 1.0999999999999996) return "severeOver";
		if (pronationY >= ave - std * 3 && pronationY < -12.9) return "under";
		if (pronationY < ave - std * 3) return "severeUnder";
		return "none";
	}
	function decodeOverview(dv, step) {
		const b = dv.getUint8(4);
		return {
			type: "overview",
			subheader: 0,
			step_number: step,
			gait_type: gaitTypeToStr(b >> 6 & 3),
			stride_direction: strideDirectionToStr(b >> 3 & 7),
			calorie: sanitizeNonNeg(getFloat16(dv, 6)),
			distance_m: sanitizeNonNeg(dv.getFloat32(8, false)),
			stance_phase_s: sanitizeNonNeg(dv.getFloat32(12, false)),
			swing_phase_s: sanitizeNonNeg(dv.getFloat32(16, false))
		};
	}
	function decodeStride(dv, step) {
		return {
			type: "stride",
			subheader: 1,
			step_number: step,
			foot_angle: sanitize(dv.getFloat32(4, false)),
			stride_x: sanitize(dv.getFloat32(8, false)),
			stride_y: sanitize(dv.getFloat32(12, false)),
			stride_z: sanitize(dv.getFloat32(16, false))
		};
	}
	function decodePronation(dv, step) {
		return {
			type: "pronation",
			subheader: 2,
			step_number: step,
			landing_force: sanitizeNonNeg(dv.getFloat32(4, false)),
			pronation_x: sanitize(dv.getFloat32(8, false)),
			pronation_y: sanitize(dv.getFloat32(12, false)),
			pronation_z: sanitize(dv.getFloat32(16, false))
		};
	}
	function decodeMotion(dv, step) {
		const b = dv.getUint8(4);
		return {
			type: "motion",
			subheader: 4,
			step_number: step,
			gait_cycle_phase: b >> 6 & 3,
			gait_cycle_period: b >> 3 & 7,
			gait_cycle_event: b & 7,
			quat_w: sanitize(getFloat16(dv, 6)),
			quat_x: sanitize(getFloat16(dv, 8)),
			quat_y: sanitize(getFloat16(dv, 10)),
			quat_z: sanitize(getFloat16(dv, 12)),
			delta_x: sanitize(getFloat16(dv, 14)),
			delta_y: sanitize(getFloat16(dv, 16)),
			delta_z: sanitize(getFloat16(dv, 18))
		};
	}
	/**
	* 歩容解析パケット（20byte）を1件デコードする。
	* 解析パケットでない場合（ヘッダー不一致・長さ不足・未知サブヘッダー）は null。
	*/
	function decodeGaitPacket(dv) {
		if (dv.byteLength < 20) return null;
		if (dv.getUint8(0) !== 51) return null;
		const subheader = dv.getUint8(1);
		const step = dv.getUint16(2, false);
		switch (subheader) {
			case 0: return decodeOverview(dv, step);
			case 1: return decodeStride(dv, step);
			case 2: return decodePronation(dv, step);
			case 4: return decodeMotion(dv, step);
			default: return null;
		}
	}
	//#endregion
	//#region src/gait/aggregator.ts
	/**
	* サブパケットを歩単位に集約し、1 歩ぶんの歩容パラメーター（GaitRow）を組み立てる。
	*
	* overview / stride / pronation は取りこぼし対策で 2 回ずつ送られるため、
	* step_number 単位で集約・重複除去し、3 種揃った歩だけを出力する。
	* step 損失（incomplete / gap / jump）の統計もここで持つ。
	*/
	var MAX_PENDING_STEPS = 64;
	var MISSED_STEP_MEMORY = 256;
	/** gaitRowToCsv / download の CSV ヘッダー行 */
	var GAIT_CSV_HEADER = "step_number,gait_type,stride_direction,distance_m,stance_phase_s,swing_phase_s,duration_s,cadence_hz,speed_mps,foot_angle_deg,stride_x_m,stride_y_m,stride_z_m,stride_norm_m,landing_force,strike_angle_deg,foot_strike,pronation_deg,pronation_type,pronation_z_deg,calorie";
	/** uint16 の wraparound を考慮した前進距離（65535→0 をまたいでも正しく数える） */
	function stepDistance(from, to) {
		return (to - from + 65536) % 65536;
	}
	/** ストライドベクトルのノルム（1歩の移動量）。成分欠損時は null */
	function strideNorm(stride) {
		const { stride_x: x, stride_y: y, stride_z: z } = stride;
		if (x === null || y === null || z === null) return null;
		return Math.sqrt(x * x + y * y + z * z);
	}
	/** overview / stride / pronation を1歩ぶんにまとめ、派生指標も算出する */
	function buildGaitRow(stepNumber, parts) {
		const { overview, stride, pronation } = parts;
		const stance = overview.stance_phase_s;
		const swing = overview.swing_phase_s;
		let duration = stance !== null && swing !== null ? stance + swing : null;
		if (duration !== null && duration <= 0) duration = null;
		const norm = strideNorm(stride);
		const durationValid = duration !== null && duration > 0;
		const cadence = durationValid ? 1 / duration : null;
		const speed = durationValid && norm !== null ? norm / duration : null;
		return {
			step_number: stepNumber,
			gait_type: overview.gait_type,
			stride_direction: overview.stride_direction,
			distance_m: overview.distance_m,
			stance_phase_s: stance,
			swing_phase_s: swing,
			duration_s: duration,
			cadence_hz: cadence,
			speed_mps: speed,
			foot_angle_deg: stride.foot_angle,
			stride_x_m: stride.stride_x,
			stride_y_m: stride.stride_y,
			stride_z_m: stride.stride_z,
			stride_norm_m: norm,
			landing_force: pronation.landing_force,
			strike_angle_deg: pronation.pronation_x,
			foot_strike: footStrikeToStr(pronation.pronation_x),
			pronation_deg: pronation.pronation_y,
			pronation_type: pronationToStr(pronation.pronation_y),
			pronation_z_deg: pronation.pronation_z,
			calorie: overview.calorie
		};
	}
	function csvCell(v) {
		if (v === null || v === void 0) return "";
		if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
		return String(v);
	}
	/** 1歩ぶんの {@link GaitRow} を {@link GAIT_CSV_HEADER} の並びで CSV 1 行にする。 */
	function gaitRowToCsv(row) {
		return [
			row.step_number,
			row.gait_type,
			row.stride_direction,
			row.distance_m,
			row.stance_phase_s,
			row.swing_phase_s,
			row.duration_s,
			row.cadence_hz,
			row.speed_mps,
			row.foot_angle_deg,
			row.stride_x_m,
			row.stride_y_m,
			row.stride_z_m,
			row.stride_norm_m,
			row.landing_force,
			row.strike_angle_deg,
			row.foot_strike,
			row.pronation_deg,
			row.pronation_type,
			row.pronation_z_deg,
			row.calorie
		].map(csvCell).join(",");
	}
	/**
	* 各サブパケットを step_number 単位に集約し、overview/stride/pronation が
	* 揃った歩を返す。サブパケットは複数回送られるため、同じ歩は一度だけ出力する。
	* step 損失（incomplete / gap / jump）も統計・通知する。
	*/
	var GaitAggregator = class {
		pending = /* @__PURE__ */ new Map();
		emitted = /* @__PURE__ */ new Set();
		lastSeenStep = null;
		missedSteps = /* @__PURE__ */ new Set();
		statsData = {
			completedSteps: 0,
			incompleteSteps: 0,
			missingParts: {
				overview: 0,
				stride: 0,
				pronation: 0
			},
			gapSteps: 0,
			jumps: 0
		};
		/** 回復不能と判定した歩の通知（InsoleGait が配線する） */
		onStepLoss = null;
		/** 損失統計の snapshot（診断用・読み取り専用） */
		stats() {
			return {
				...this.statsData,
				missingParts: { ...this.statsData.missingParts },
				lastSeenStep: this.lastSeenStep,
				pendingSteps: this.pending.size
			};
		}
		/**
		* サブパケットを 1 件取り込む。
		* @returns その歩の 3 種が揃ったら完成した {@link GaitRow}、まだなら null
		*/
		add(packet) {
			const step = packet.step_number;
			if (this.emitted.has(step)) return null;
			if (this.missedSteps.delete(step)) this.statsData.gapSteps = Math.max(0, this.statsData.gapSteps - 1);
			const isNewStep = !this.pending.has(step);
			let parts = this.pending.get(step);
			if (!parts) {
				parts = {};
				this.pending.set(step, parts);
			}
			if (packet.type === "overview") parts.overview = packet;
			else if (packet.type === "stride") parts.stride = packet;
			else parts.pronation = packet;
			if (isNewStep) this.noteStepSeen(step);
			let row = null;
			if (parts.overview && parts.stride && parts.pronation) {
				row = buildGaitRow(step, parts);
				this.pending.delete(step);
				this.markEmitted(step);
				this.statsData.completedSteps++;
			}
			this.evictStalePending();
			this.evictOldPending();
			return row;
		}
		noteStepSeen(step) {
			if (this.lastSeenStep === null) {
				this.lastSeenStep = step;
				return;
			}
			const forward = stepDistance(this.lastSeenStep, step);
			if (forward === 0) return;
			if (forward > 64) {
				if (stepDistance(step, this.lastSeenStep) <= 64) return;
				this.statsData.jumps++;
				const from = this.lastSeenStep;
				this.lastSeenStep = step;
				this.notifyLoss({
					reason: "step_number_jump",
					from,
					to: step,
					forward
				});
				return;
			}
			if (forward > 1) {
				const missed = [];
				for (let i = 1; i < forward; i++) {
					const missedStep = (this.lastSeenStep + i) % 65536;
					if (this.pending.has(missedStep) || this.emitted.has(missedStep)) continue;
					missed.push(missedStep);
					this.missedSteps.add(missedStep);
					while (this.missedSteps.size > MISSED_STEP_MEMORY) this.missedSteps.delete(this.missedSteps.values().next().value);
				}
				if (missed.length > 0) {
					this.statsData.gapSteps += missed.length;
					this.notifyLoss({
						reason: "gap",
						steps: missed,
						count: missed.length
					});
				}
			}
			this.lastSeenStep = step;
		}
		evictStalePending() {
			if (this.lastSeenStep === null) return;
			for (const [step, parts] of this.pending) if (stepDistance(step, this.lastSeenStep) >= 8) {
				this.pending.delete(step);
				this.countIncomplete(step, parts);
			}
		}
		countIncomplete(step, parts) {
			this.statsData.incompleteSteps++;
			const missing = [];
			for (const type of [
				"overview",
				"stride",
				"pronation"
			]) if (!parts[type]) {
				this.statsData.missingParts[type]++;
				missing.push(type);
			}
			this.notifyLoss({
				reason: "incomplete",
				step_number: step,
				missing
			});
		}
		notifyLoss(info) {
			if (!this.onStepLoss) return;
			try {
				this.onStepLoss(info);
			} catch {}
		}
		markEmitted(step) {
			this.emitted.add(step);
			const cap = 256;
			while (this.emitted.size > cap) this.emitted.delete(this.emitted.values().next().value);
		}
		evictOldPending() {
			while (this.pending.size > MAX_PENDING_STEPS) {
				const oldest = this.pending.keys().next().value;
				const parts = this.pending.get(oldest);
				this.pending.delete(oldest);
				this.countIncomplete(oldest, parts);
			}
		}
	};
	//#endregion
	//#region src/gait/analyzer.ts
	/**
	* InsoleGait — 歩容解析のリアルタイム取得（opt-in）。
	*
	* INSOLE の FW（GaitAnalysisCore / StrideAnalyzer）は歩行中の歩容パラメーター
	* （ストライド・立脚期/遊脚期・接地パターン・プロネーション等）を計算し、
	* STEP_ANALYSIS characteristic で公開する。アクティブ状態になると 50Hz で
	* 自動 notify されるため、subscribe するだけでよい（read モード変更は不要）。
	*
	* 使い方:
	*   const gait = new InsoleGait(ble);            // ble は begin() 済み
	*   gait.onGait = (deviceId, row) => { ... };
	*   await gait.start();
	*   ...
	*   await gait.stop();
	*/
	/**
	* 歩容解析のリアルタイム取得。begin() 済みの OrpheCoreInsole（insoleProfile）を渡して使う。
	* STEP_ANALYSIS の notify は setNotifySink で横取りし、通常のセンサー配送
	* （周波数計測・parse）には流さない。1つの OrpheCoreInsole に対して active な
	* InsoleGait は同時に1つ（多重 start は失敗する）。
	*/
	var InsoleGait = class {
		/** 解析対象のデバイス（begin() 済みの OrpheCoreInsole） */
		ble;
		/**
		* サブパケットを歩単位にまとめる集約器
		*
		* @internal
		*/
		aggregator = new GaitAggregator();
		/** 完成した歩容パラメーター（CSV 出力用） */
		rows = [];
		/** 1歩ぶんが揃うたびに呼ばれる */
		onGait = null;
		/** motion パケット（姿勢・変位の連続ストリーム）が届くたびに呼ばれる */
		onMotion = null;
		/** デコードできたサブパケットをそのまま流す（種別を問わない） */
		onRaw = null;
		/** notify を受け取るたびの観測値（購読の生死を診断する用） */
		onTransport = null;
		/** 購読の再開・タイムアウトなど内部イベントの通知 */
		onDiagnostic = null;
		/** 歩の損失が確定したときの通知 */
		onStepLoss = null;
		/** 解析中に起きた例外の通知 */
		onError = null;
		running = false;
		subscribed = false;
		lifecycle = Promise.resolve();
		removeSink = null;
		removeReconnectHook = null;
		removeDisconnectHook = null;
		transportNotifications = 0;
		validPackets = 0;
		invalidPackets = 0;
		lastTransportAt = null;
		lastValidPacketAt = null;
		lastTransport = null;
		packetWaiters = /* @__PURE__ */ new Set();
		reportedInvalidSignatures = /* @__PURE__ */ new Set();
		constructor(ble) {
			this.ble = ble;
			this.attachAggregatorHooks();
		}
		/** デバイス識別子。 */
		get deviceId() {
			return this.ble.id;
		}
		/** これまでに完成した歩数（{@link rows} の件数）。 */
		get stepCount() {
			return this.rows.length;
		}
		/** 解析中なら true。 */
		get isRunning() {
			return this.running;
		}
		/**
		* 集約結果と診断カウンタを捨てて初期状態へ戻す。
		* 解析中は何も変更しない（stop() してから呼ぶこと）。
		*/
		reset() {
			if (this.running) return;
			this.aggregator = new GaitAggregator();
			this.attachAggregatorHooks();
			this.rows = [];
			this.transportNotifications = 0;
			this.validPackets = 0;
			this.invalidPackets = 0;
			this.lastTransportAt = null;
			this.lastValidPacketAt = null;
			this.lastTransport = null;
			this.reportedInvalidSignatures.clear();
		}
		/** STEP_ANALYSIS transport の観測状態（購読成功と実データ到着を分けて診断する） */
		diagnostics() {
			return {
				running: this.running,
				subscribed: this.subscribed,
				transportNotifications: this.transportNotifications,
				validPackets: this.validPackets,
				invalidPackets: this.invalidPackets,
				lastTransportAt: this.lastTransportAt,
				lastValidPacketAt: this.lastValidPacketAt,
				lastTransport: this.lastTransport ? { ...this.lastTransport } : null,
				stepLoss: this.aggregator.stats()
			};
		}
		/**
		* 指定時点より後の有効 packet を待つ。「購読開始＝受信成功」と誤認しないために使う。
		* @returns timeout 前に有効 packet が到着したら true
		*/
		waitForPacket(options = {}) {
			const afterCount = Number.isFinite(Number(options.afterCount)) ? Number(options.afterCount) : this.validPackets;
			const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : 1200;
			if (this.validPackets > afterCount) return Promise.resolve(true);
			if (!this.running || !this.subscribed || timeoutMs === 0) return Promise.resolve(false);
			return new Promise((resolve) => {
				const waiter = {
					afterCount,
					resolve,
					timer: null
				};
				waiter.timer = setTimeout(() => {
					if (!this.packetWaiters.delete(waiter)) return;
					this.emitDiagnostic("packet-timeout", {
						afterCount,
						timeoutMs
					});
					resolve(false);
				}, timeoutMs);
				this.packetWaiters.add(waiter);
				if (this.validPackets > afterCount) this.resolvePacketWaiters(true);
			});
		}
		/**
		* 歩容解析の notify を開始する（begin() 済みであること）。
		* start()/stop() は直列化され、交錯しても最終状態が確定する。
		* @returns 開始できたら true
		*/
		start() {
			return this.enqueue(() => this.doStart());
		}
		/** 歩容解析の notify を停止する */
		stop() {
			return this.enqueue(() => this.doStop());
		}
		/**
		* STEP_ANALYSIS をいったん停止して再購読する。FIFO の読み取りモード切替で
		* FW 側の通知が止まった場合に使う。aggregator / rows は維持する。
		*/
		refreshSubscription() {
			return this.enqueue(() => this.doRefresh());
		}
		/** これまでの {@link rows} をヘッダー行付きの CSV 文字列にする。 */
		toCSV() {
			const lines = [GAIT_CSV_HEADER];
			for (const row of this.rows) lines.push(gaitRowToCsv(row));
			return lines.join("\n") + "\n";
		}
		/** ブラウザで CSV をダウンロードする */
		download(filename = "orphe-insole-gait.csv") {
			downloadCsv(this.toCSV(), filename);
		}
		enqueue(operation) {
			const next = this.lifecycle.then(operation, operation);
			this.lifecycle = next.catch(() => {});
			return next;
		}
		async doStart() {
			if (this.running && this.subscribed) return true;
			if (!this.ble.isConnected()) {
				this.reportError(/* @__PURE__ */ new Error("InsoleGait.start(): insole is not connected"));
				return false;
			}
			if (!this.running) {
				this.aggregator = new GaitAggregator();
				this.attachAggregatorHooks();
				this.rows = [];
			}
			if (!this.removeSink) try {
				this.removeSink = this.ble.setNotifySink("STEP_ANALYSIS", (value) => this.onPacket(value));
			} catch (error) {
				this.reportError(error);
				return false;
			}
			this.running = true;
			this.removeReconnectHook ??= this.ble.transport.addAfterReconnectSuccessHook(() => this.onReconnected());
			this.removeDisconnectHook ??= this.ble.transport.addDisconnectHook(() => this.onPhysicalDisconnect());
			const ok = await this.subscribe();
			if (!ok && !this.subscribed) {
				this.running = false;
				this.removeHooks();
			}
			return ok;
		}
		async doStop() {
			const wasSubscribed = this.subscribed;
			const wasRunning = this.running || wasSubscribed;
			this.running = false;
			this.subscribed = false;
			this.removeHooks();
			this.resolvePacketWaiters(false);
			if (!wasRunning) return;
			if (wasSubscribed && this.ble.isConnected()) try {
				await this.ble.transport.stopNotify("STEP_ANALYSIS");
			} catch {}
		}
		async doRefresh() {
			if (!this.running) return false;
			const wasSubscribed = this.subscribed;
			this.subscribed = false;
			if (wasSubscribed && this.ble.isConnected()) try {
				await this.ble.transport.stopNotify("STEP_ANALYSIS");
			} catch (error) {
				this.reportError(error);
			}
			if (!this.running) return false;
			return this.subscribe();
		}
		async subscribe() {
			try {
				await this.ble.transport.startNotify("STEP_ANALYSIS");
				if (!this.running) return false;
				this.subscribed = true;
				this.emitDiagnostic("subscription-started");
				return true;
			} catch (error) {
				if (this.running) this.reportError(error);
				return false;
			}
		}
		async onReconnected() {
			if (!this.running || this.subscribed) return;
			await this.enqueue(async () => {
				if (!this.running || this.subscribed) return;
				await this.subscribe();
			});
		}
		onPhysicalDisconnect() {
			this.subscribed = false;
			this.resolvePacketWaiters(false);
			this.emitDiagnostic("physical-disconnect");
		}
		removeHooks() {
			this.removeSink?.();
			this.removeSink = null;
			this.removeReconnectHook?.();
			this.removeReconnectHook = null;
			this.removeDisconnectHook?.();
			this.removeDisconnectHook = null;
		}
		onPacket(dv) {
			const receivedAt = Date.now();
			const byteLength = dv.byteLength;
			const header = byteLength > 0 ? dv.getUint8(0) : null;
			const subheader = byteLength > 1 ? dv.getUint8(1) : null;
			this.transportNotifications++;
			this.lastTransportAt = receivedAt;
			let packet = null;
			try {
				packet = decodeGaitPacket(dv);
			} catch (error) {
				this.reportError(error);
			}
			const info = {
				receivedAt,
				byteLength,
				header,
				subheader,
				valid: !!packet,
				transportNotifications: this.transportNotifications,
				validPackets: this.validPackets + (packet ? 1 : 0),
				invalidPackets: this.invalidPackets + (packet ? 0 : 1)
			};
			this.lastTransport = info;
			if (this.onTransport) this.safe(() => this.onTransport(this.deviceId, { ...info }));
			if (!packet) {
				this.invalidPackets++;
				const signature = `${byteLength}:${header}:${subheader}`;
				if (!this.reportedInvalidSignatures.has(signature)) {
					this.reportedInvalidSignatures.add(signature);
					this.emitDiagnostic("invalid-packet", {
						byteLength,
						header,
						subheader
					});
				}
				return;
			}
			this.validPackets++;
			this.lastValidPacketAt = receivedAt;
			if (this.validPackets === 1) this.emitDiagnostic("first-valid-packet", {
				byteLength,
				header,
				subheader,
				packetType: packet.type
			});
			this.resolvePacketWaiters(true);
			if (this.onRaw) this.safe(() => this.onRaw(this.deviceId, packet));
			if (packet.type === "motion") {
				if (this.onMotion) this.safe(() => this.onMotion(this.deviceId, packet));
				return;
			}
			const row = this.aggregator.add(packet);
			if (row) {
				this.rows.push(row);
				if (this.onGait) this.safe(() => this.onGait(this.deviceId, row));
			}
		}
		attachAggregatorHooks() {
			this.aggregator.onStepLoss = (info) => {
				if (this.onStepLoss) this.safe(() => this.onStepLoss(this.deviceId, { ...info }));
				this.emitDiagnostic("step-loss", info);
			};
		}
		resolvePacketWaiters(packetArrived) {
			for (const waiter of [...this.packetWaiters]) {
				if (packetArrived && this.validPackets <= waiter.afterCount) continue;
				this.packetWaiters.delete(waiter);
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.resolve(packetArrived);
			}
		}
		emitDiagnostic(type, detail = {}) {
			if (!this.onDiagnostic) return;
			this.safe(() => this.onDiagnostic(this.deviceId, {
				type,
				...detail,
				diagnostics: this.diagnostics()
			}));
		}
		safe(fn) {
			try {
				fn();
			} catch (error) {
				this.reportError(error);
			}
		}
		reportError(error) {
			if (this.onError) try {
				this.onError(error);
				return;
			} catch {}
			this.ble.reportError(error);
		}
	};
	//#endregion
	//#region src/compat/legacy-device.ts
	var DEFAULT_TIME_SYNC_SAMPLES = 3;
	/** クラスごとの生成済みインスタンス（別スロットへの同一デバイス割当を防ぐ） */
	var registries = /* @__PURE__ */ new Map();
	var LegacyDevice = class {
		/** スロット番号（0 or 1） */
		id;
		/** 内包する OrpheCoreInsole。新 API と併用したい場合はこれを使う */
		device;
		/** デバッグログ（console.info）を有効にする */
		debug = false;
		/** 直近の begin() に渡された notification type */
		notification_type;
		/** 直近の時刻同期で推定した片道遅延 [ms] */
		half_round_trip_time = 0;
		/** 直近の getDateTime() の結果 */
		date_time = null;
		/** 別スロットのインスタンスが使っているデバイスを選んだとき、接続を拒否する。既定 true */
		rejectDuplicateDevices = true;
		hooks = [];
		detachLegacy = null;
		constructor(profile, id, injections = {}) {
			this.id = id;
			this.notification_type = profile.defaultNotificationType;
			let registry = registries.get(this.constructor);
			if (!registry) {
				registry = /* @__PURE__ */ new Set();
				registries.set(this.constructor, registry);
			}
			registry.add(this);
			this.device = new OrpheCoreInsole({
				profile,
				id,
				...injections,
				deviceGuard: (device) => this.deviceAssignmentError(device),
				events: {
					onScan: (name) => this.onScan(name),
					onConnect: (uuid) => {
						this.onConnectGATT(uuid);
						this.onConnect(uuid);
					},
					onDisconnect: (event) => this.onDisconnect(event),
					onError: (error) => this.onError(error),
					onWrite: (uuid) => this.onWrite(uuid),
					onStartNotify: (uuid) => this.onStartNotify(uuid),
					onStopNotify: (uuid) => this.onStopNotify(uuid),
					onReconnectAttempt: (info) => this.onReconnectAttempt(info),
					onReconnectSuccess: (info) => this.onReconnectSuccess(info),
					onReconnectFailed: (info) => this.onReconnectFailed(info)
				},
				log: (message, detail) => this._log(message, detail)
			});
			this.device.transport.addAfterReconnectSuccessHook(() => this.runAfterReconnectSuccessHooks());
		}
		/** サブクラスのコンストラクタ末尾で呼ぶ（got* の既定実装を this に持ってから接続する） */
		attachCallbacks() {
			this.detachLegacy?.();
			this.detachLegacy = attachLegacyCallbacks(this.device, this);
			this.device.on("*", (sample) => this.updateState(sample));
		}
		/** 同じ Bluetooth デバイスを別スロットのインスタンスが使っていればそれを返す */
		findBluetoothDeviceInUse(device) {
			if (!device) return null;
			for (const instance of registries.get(this.constructor) ?? []) {
				if (instance === this || instance.id === this.id) continue;
				const assigned = instance.bluetoothDevice;
				if (!assigned) continue;
				if (assigned === device || assigned.id && device.id && assigned.id === device.id) return instance;
			}
			return null;
		}
		deviceAssignmentError(device) {
			if (!this.rejectDuplicateDevices) return null;
			const inUseBy = this.findBluetoothDeviceInUse(device);
			if (!inUseBy) return null;
			return `Bluetooth device "${device.name || device.id || "unknown"}" is already assigned to ${this.deviceLabel} ${String(inUseBy.id + 1).padStart(2, "0")}. Select a different device.`;
		}
		/** BLE トランスポート */
		get transport() {
			return this.device.transport;
		}
		/** 現在割り当てられている Bluetooth デバイス。未選択なら null */
		get bluetoothDevice() {
			return this.device.transport.device;
		}
		/** 接続中の FW 情報（begin() で読む。読めない個体では null） */
		get firmware() {
			return this.device.firmware;
		}
		/** 接続状態（'disconnected' / 'connecting' / 'connected' / 'reconnecting'） */
		get connectionState() {
			return this.device.connectionState;
		}
		isConnected() {
			return this.device.isConnected();
		}
		scan(uuid, options = {}) {
			return this.device.transport.scan(uuid, options);
		}
		/** chooser を開いてデバイスを選び直す（記憶は使わない） */
		requestDevice(uuid = "DEVICE_INFORMATION") {
			return this.device.transport.scan(uuid, { forceDeviceSelection: true });
		}
		connectGATT(uuid, options = {}) {
			return this.device.transport.connectGATT(uuid, options);
		}
		read(uuid, options = {}) {
			return this.device.transport.read(uuid, options);
		}
		write(uuid, data, options = {}) {
			return this.device.transport.write(uuid, data, options);
		}
		startNotify(uuid, options = {}) {
			return this.device.transport.startNotify(uuid, options);
		}
		/** notify を停止する。失敗は onError に報告し、reject はしない */
		stopNotify(uuid, options = {}) {
			return this.device.transport.stopNotify(uuid, options).catch(() => void 0);
		}
		/** 記憶を破棄して必ず chooser を開く。接続済みデバイスから別デバイスへ切り替えるときに使う */
		selectBluetoothDevice(_uuid = "DEVICE_INFORMATION") {
			return this.device.transport.selectDevice();
		}
		/** 前回接続に成功して記憶しているデバイス（無ければ null） */
		getLastBluetoothDeviceInfo() {
			return this.device.transport.rememberedDevice();
		}
		/** 記憶デバイスを忘れる。次回 begin() は必ず chooser を出す */
		forgetLastBluetoothDevice() {
			this.device.transport.forgetRememberedDevice();
		}
		/** GATT を切断する（クリアはしない）。手動切断は reset() を使う */
		disconnect() {
			this.device.transport.disconnect();
		}
		/** 切断せずにデバイス割り当てだけ解除する */
		clear() {
			this.device.transport.clear();
			this.onClear();
		}
		/** 切断 + クリア + 自動再接続解除 */
		reset() {
			this.device.reset();
			this.onReset();
		}
		/** reset() と同じ */
		stop() {
			this.reset();
		}
		/**
		* 自動再接続の成功後に呼ぶ内部フックを登録し、解除関数を返す。
		* begin() が再購読する経路以外の characteristic を再購読するために使う。
		*/
		addAfterReconnectSuccessHook(hook) {
			this.hooks.push(hook);
			return () => {
				const index = this.hooks.indexOf(hook);
				if (index >= 0) this.hooks.splice(index, 1);
			};
		}
		runAfterReconnectSuccessHooks() {
			for (const hook of [...this.hooks]) try {
				const result = hook();
				if (result && typeof result.catch === "function") result.catch((error) => this.onError(error));
			} catch (error) {
				this.onError(error);
			}
		}
		/** 旧 API の平坦な再接続オプションを OrpheCoreInsole の形に直す */
		toBeginOptions(options) {
			const { reconnectIntervalMs, reconnectMaxAttempts, ...rest } = options;
			const reconnect = {};
			if (Number.isFinite(Number(reconnectIntervalMs)) && Number(reconnectIntervalMs) >= 0) reconnect.intervalMs = Number(reconnectIntervalMs);
			if (Number.isFinite(Number(reconnectMaxAttempts)) && Number(reconnectMaxAttempts) > 0) reconnect.maxAttempts = Number(reconnectMaxAttempts);
			return {
				...rest,
				reconnect
			};
		}
		/** 接続シーケンスを実行する。失敗は onError に報告したうえで throw する */
		async runBegin(type, options) {
			this.notification_type = type;
			return await this.device.begin(type, this.toBeginOptions(options));
		}
		/** デバイスの時刻を読む（往復時間つき） */
		async getDateTime() {
			this.date_time = await readDateTime(this.device.transport);
			return this.date_time;
		}
		/** Date をデバイスへ書き込む */
		setDateTime(date) {
			return writeDateTime(this.device.transport, date);
		}
		/** デバイスの時計を PC 時刻 + 平均往復時間/2 に同期する */
		async syncCoreTime(n = DEFAULT_TIME_SYNC_SAMPLES) {
			const result = await syncDeviceTime(this.device.transport, { samples: n });
			this.half_round_trip_time = result.half_round_trip_time;
			return result;
		}
		/** 内部動作の詳細ログ（debug 時だけ console.info に出す） */
		_log(message, detail) {
			if (this.debug) console.info(`[${this.constructor.name}]`, message, detail ?? "");
		}
		/** 既定のライフサイクルコールバックの進行ログ（debug 時だけ console.log に出す） */
		progress(name, detail) {
			if (!this.debug) return;
			if (detail === void 0) console.log(name);
			else console.log(name, detail);
		}
		notSupported(name) {
			return new TransportError("UNSUPPORTED_MODE", `${name} is not supported on this device.`);
		}
		/** gotData を上書きすると生 DataView が届き、他の got* は止まる */
		gotData(_data, _uuid) {}
		gotBLEFrequency(_frequency) {}
		lostData(_serial_number, _serial_number_prev) {}
		onScan(_deviceName) {
			this.progress("onScan");
		}
		onConnectGATT(_uuid) {
			this.progress("onConnectGATT");
		}
		onConnect(_uuid) {
			this.progress("onConnect");
		}
		onWrite(_uuid) {
			this.progress("onWrite");
		}
		onStartNotify(uuid) {
			this.progress("onStartNotify", uuid);
		}
		onStopNotify(uuid) {
			this.progress("onStopNotify", uuid);
		}
		onDisconnect(_event) {
			this.progress("onDisconnect");
		}
		onReconnectAttempt(_info) {}
		onReconnectSuccess(_info) {}
		onReconnectFailed(_info) {}
		onClear() {
			this.progress("onClear");
		}
		onReset() {
			this.progress("onReset");
		}
		onError(error) {
			console.error("onError: ", error);
		}
	};
	//#endregion
	//#region src/compat/orphe-core.ts
	var EMPTY_GAIT = () => ({
		type: 0,
		direction: 0,
		calorie: 0,
		distance: 0,
		steps: 0,
		standing_phase_duration: 0,
		swing_phase_duration: 0
	});
	var Orphe = class extends LegacyDevice {
		ORPHE_INFORMATION = ORPHE_UUID.INFORMATION_SERVICE;
		ORPHE_DEVICE_INFORMATION = ORPHE_UUID.DEVICE_INFORMATION;
		ORPHE_DATE_TIME = ORPHE_UUID.DATE_TIME;
		ORPHE_OTHER_SERVICE = ORPHE_UUID.OTHER_SERVICE;
		ORPHE_SENSOR_VALUES = ORPHE_UUID.SENSOR_VALUES;
		ORPHE_STEP_ANALYSIS = ORPHE_UUID.STEP_ANALYSIS;
		/** 内包する CoreProfile（device_information の持ち主） */
		profile;
		deviceLabel = "ORPHE CORE";
		gait = EMPTY_GAIT();
		stride = {
			foot_angle: 0,
			x: 0,
			y: 0,
			z: 0,
			steps: 0
		};
		pronation = {
			landing_impact: 0,
			x: 0,
			y: 0,
			z: 0,
			steps: 0
		};
		steps_number = 0;
		quat = {
			w: 0,
			x: 0,
			y: 0,
			z: 0
		};
		delta = {
			x: 0,
			y: 0,
			z: 0
		};
		euler = {
			pitch: 0,
			roll: 0,
			yaw: 0
		};
		gyro = {
			x: 0,
			y: 0,
			z: 0
		};
		acc = {
			x: 0,
			y: 0,
			z: 0
		};
		converted_gyro = {
			x: 0,
			y: 0,
			z: 0
		};
		converted_acc = {
			x: 0,
			y: 0,
			z: 0
		};
		/** 直近に受信した serial 番号 */
		serial_number = 0;
		constructor(id = 0, injections = {}) {
			const profile = coreProfile({
				namePrefix: "CR-",
				...injections.profile
			});
			const { profile: _profile, bridgeEnvironment, bridgeTiming, ...deviceInjections } = injections;
			const sharedBridge = {};
			if (bridgeEnvironment) sharedBridge.environment = bridgeEnvironment;
			if (bridgeTiming) sharedBridge.timing = bridgeTiming;
			super(profile, id, {
				...deviceInjections,
				sharedBridge
			});
			this.profile = profile;
			this.attachCallbacks();
		}
		/** begin() で取得したデバイス情報。未取得なら '' */
		get device_information() {
			const info = this.profile.device_information;
			return info ? {
				...info,
				data: info.raw
			} : "";
		}
		/** 別タブの BLE 接続を共有する Secondary として動作中なら true */
		get isBridgeSecondary() {
			return this.device.sharedBridgeRole === "secondary";
		}
		updateState(sample) {
			if (sample.quat) this.quat = sample.quat;
			if (sample.gyro) this.gyro = sample.gyro;
			if (sample.acc) this.acc = sample.acc;
			if (sample.converted_gyro) this.converted_gyro = sample.converted_gyro;
			if (sample.converted_acc) this.converted_acc = sample.converted_acc;
			if (sample.euler) this.euler = sample.euler;
			if (sample.delta) this.delta = sample.delta;
			if (sample.gait) this.gait = sample.gait;
			if (sample.stride) this.stride = {
				...sample.stride,
				foot_angle: sample.foot_angle?.value ?? 0,
				steps: sample.stride.steps_number
			};
			if (sample.pronation) this.pronation = {
				...sample.pronation,
				landing_impact: sample.landing_impact?.value ?? 0,
				steps: sample.steps_number?.value ?? this.steps_number
			};
			if (sample.steps_number) this.steps_number = sample.steps_number.value;
			if (typeof sample.serial_number === "number") this.serial_number = sample.serial_number;
		}
		/** 互換のために残す初期化。characteristic は profile が持つので何もしない */
		setup(_names = [], _options = {}) {}
		/** 論理名 → UUID を上書き登録する */
		setUUID(name, serviceUUID, characteristicUUID) {
			this.transport.registerCharacteristic(name, {
				serviceUUID,
				characteristicUUID
			});
		}
		/**
		* 接続してデータ取得を開始する。
		* useSharedBridge: true のとき、別タブが同じスロットの BLE 接続を持っていれば、そのタブから配信を受ける Secondary になる。
		* 失敗は onError に報告したうえで reject する。
		*/
		begin(str_type = "STEP_ANALYSIS", options = {}) {
			return this.runBegin(str_type, options);
		}
		selectBluetoothDevice(uuid = "DEVICE_INFORMATION") {
			this.device.releaseSharedBridge();
			return super.selectBluetoothDevice(uuid);
		}
		/** デバイス情報を読んで device_information を更新する */
		async getDeviceInformation() {
			const data = await this.read("DEVICE_INFORMATION");
			this.profile.device_information = decodeCoreDeviceInformation(data);
			return this.device_information;
		}
		/** device_information 形式のオブジェクトを書き込んでデバイス設定を変える */
		setDeviceInformation(obj) {
			return this.write("DEVICE_INFORMATION", encodeCoreDeviceInformation(obj));
		}
		/** LED の点灯パターンを設定する（on_off: 0/1、pattern: 0..4） */
		setLED(on_off, pattern) {
			return this.write("DEVICE_INFORMATION", [
				DEVICE_INFORMATION_OPCODE.SET_LED,
				on_off,
				pattern
			]);
		}
		/** LED の明るさを設定する（0..255、0 で消灯）。デバイス情報は取得済みであること */
		async setLEDBrightness(value) {
			const info = this.profile.device_information ?? decodeCoreDeviceInformation(await this.read("DEVICE_INFORMATION"));
			info.led_brightness = value;
			this.profile.device_information = info;
			await this.setDeviceInformation(info);
		}
		/** 取付位置を設定する（0: left-instep, 1: right-instep, 2: left-plantar, 3: right-plantar） */
		async setMountPosition(position) {
			if (!Number.isInteger(position) || position < 0 || position > 3) throw new Error("Invalid position");
			const info = await this.getDeviceInformation();
			info.lr = position;
			this.profile.device_information = info;
			await this.setDeviceInformation(info);
		}
		/** 姿勢（クォータニオン計算）をリセットする */
		resetMotionSensorAttitude() {
			return this.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ATTITUDE]);
		}
		/** 解析ログ（歩数など）をリセットする */
		resetAnalysisLogs() {
			this.profile.resetAnalysisState();
			this.gait = EMPTY_GAIT();
			this.stride = {
				foot_angle: 0,
				x: 0,
				y: 0,
				z: 0,
				steps: 0
			};
			this.pronation = {
				landing_impact: 0,
				x: 0,
				y: 0,
				z: 0,
				steps: 0
			};
			this.steps_number = 0;
			return this.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ANALYSIS_LOGS]);
		}
		gotQuat(_quat) {}
		gotGyro(_gyro) {}
		gotAcc(_acc) {}
		gotConvertedGyro(_gyro) {}
		gotConvertedAcc(_acc) {}
		gotDelta(_delta) {}
		gotEuler(_euler) {}
		gotGait(_gait) {}
		gotType(_type) {}
		gotDirection(_direction) {}
		gotCalorie(_calorie) {}
		gotDistance(_distance) {}
		gotStandingPhaseDuration(_duration) {}
		gotSwingPhaseDuration(_duration) {}
		gotStride(_stride) {}
		gotFootAngle(_foot_angle) {}
		gotPronation(_pronation) {}
		gotLandingImpact(_landing_impact) {}
		gotStepsNumber(_steps_number) {}
	};
	//#endregion
	//#region src/compat/orphe-insole.ts
	/**
	* OrpheInsole — `new OrpheInsole(0)` + `gotPress = function…` スタイルの INSOLE API。
	* 通信・パース・接続シーケンスは OrpheCoreInsole + insoleProfile が担い、ここは
	* 旧来の呼び出し形をそのまま受けるための薄い層。
	*/
	var REALTIME_HEADERS$1 = /* @__PURE__ */ new Set([
		50,
		55,
		56
	]);
	var OrpheInsole = class extends LegacyDevice {
		static STREAMING_MODES = INSOLE_STREAMING_MODES;
		/** SENSOR_VALUES の DataView を INSOLE のサンプル列に変換する */
		static parseSensorValues(data, options = {}) {
			return parseInsoleSensorValues(data, options);
		}
		/** リアルタイム配信モードの仕様を返す */
		static getStreamingModeInfo(mode) {
			return INSOLE_STREAMING_MODES[Number(mode)] ?? null;
		}
		ORPHE_INFORMATION = ORPHE_UUID.INFORMATION_SERVICE;
		ORPHE_DEVICE_INFORMATION = ORPHE_UUID.DEVICE_INFORMATION;
		ORPHE_DATE_TIME = ORPHE_UUID.DATE_TIME;
		ORPHE_OTHER_SERVICE = ORPHE_UUID.OTHER_SERVICE;
		ORPHE_SENSOR_VALUES = ORPHE_UUID.SENSOR_VALUES;
		ORPHE_STEP_ANALYSIS = ORPHE_UUID.STEP_ANALYSIS;
		/** 内包する InsoleProfile（device_information / streaming_mode / 圧力校正の持ち主） */
		profile;
		deviceLabel = "ORPHE INSOLE";
		quat = {
			w: 0,
			x: 0,
			y: 0,
			z: 0
		};
		delta = {
			x: 0,
			y: 0,
			z: 0
		};
		euler = {
			pitch: 0,
			roll: 0,
			yaw: 0
		};
		gyro = {
			x: 0,
			y: 0,
			z: 0
		};
		acc = {
			x: 0,
			y: 0,
			z: 0
		};
		press = { values: [
			0,
			0,
			0,
			0,
			0,
			0
		] };
		converted_press = { values: [
			0,
			0,
			0,
			0,
			0,
			0
		] };
		converted_gyro = {
			x: 0,
			y: 0,
			z: 0
		};
		converted_acc = {
			x: 0,
			y: 0,
			z: 0
		};
		/** 最後に受信した advertisement のステータス。未受信なら null */
		lastStatus = null;
		/** getFirmwareVersion() が解決したバージョン文字列のキャッシュ */
		firmware_version = null;
		/** 直近に受信した serial 番号 */
		serial_number = 0;
		sensorDataListeners = /* @__PURE__ */ new Set();
		detachSensorData = null;
		advertisementListener = null;
		constructor(id = 0, injections = {}) {
			const profile = insoleProfile();
			super(profile, id, injections);
			this.profile = profile;
			this.attachCallbacks();
		}
		/** begin() で取得したデバイス情報。未取得なら '' */
		get device_information() {
			return this.profile.device_information ?? "";
		}
		/** 現在のデータストリーミングモード。未設定なら undefined */
		get streaming_mode() {
			return this.profile.streaming_mode ?? void 0;
		}
		updateState(sample) {
			if (sample.quat) this.quat = sample.quat;
			if (sample.gyro) this.gyro = sample.gyro;
			if (sample.acc) this.acc = sample.acc;
			if (sample.press) this.press = sample.press;
			if (sample.converted_press) this.converted_press = sample.converted_press;
			if (sample.converted_gyro) this.converted_gyro = sample.converted_gyro;
			if (sample.converted_acc) this.converted_acc = sample.converted_acc;
			if (sample.euler) this.euler = sample.euler;
			if (typeof sample.serial_number === "number") this.serial_number = sample.serial_number;
		}
		/** 互換のために残す初期化。characteristic は profile が持つので何もしない */
		setup(_names = [], _options = {}) {}
		/** 論理名 → UUID を上書き登録する */
		setUUID(name, serviceUUID, characteristicUUID) {
			this.transport.registerCharacteristic(name, {
				serviceUUID,
				characteristicUUID
			});
		}
		/**
		* 接続して SENSOR_VALUES の取得を開始する。
		* 失敗は onError に報告したうえで reject する。
		*/
		async begin(str_type = "SENSOR_VALUES", options = {}) {
			let type = str_type;
			if (typeof type === "object" && type !== null) {
				options = type;
				type = "SENSOR_VALUES";
			}
			if (type === "RAW") {
				console.warn("RAW is deprecated. Please use SENSOR_VALUES instead.");
				type = "SENSOR_VALUES";
			}
			if (type !== "SENSOR_VALUES") {
				console.warn(`${String(type)} is not supported on ORPHE INSOLE. SENSOR_VALUES will be used instead.`);
				type = "SENSOR_VALUES";
			}
			return this.runBegin(type, options);
		}
		/** データストリーミングモード（1 / 3 / 4）を書き込む。接続中の切替にも使える */
		setDataStreamingMode(mode = 4) {
			return this.profile.setDataStreamingMode(this.transport, mode);
		}
		/** デバイス情報を読んで device_information を更新する */
		async getDeviceInformation() {
			const data = await this.read("DEVICE_INFORMATION");
			this.profile.device_information = decodeInsoleDeviceInformation(data);
			return this.profile.device_information;
		}
		/** INSOLE の FW では未対応 */
		setDeviceInformation(_obj) {
			const error = this.notSupported("setDeviceInformation");
			console.warn(error.message);
			this.onError(error);
		}
		/** 解析ログをリセットする */
		resetAnalysisLogs() {
			return this.write("DEVICE_INFORMATION", [DEVICE_INFORMATION_OPCODE.RESET_ANALYSIS_LOGS]);
		}
		/**
		* ファームウェアバージョン文字列。advertisement から受信していれば返し、
		* なければ FW 情報のビルド ID を返す。どちらもなければ null（例外は投げない）。
		*/
		async getFirmwareVersion() {
			if (this.firmware_version) return this.firmware_version;
			const version = this.lastStatus?.version ?? this.firmware?.name ?? null;
			if (version) this.firmware_version = version;
			return version;
		}
		/**
		* デコード済みのリアルタイムパケットを購読する。got* とは独立に呼ばれ、解除関数を返す。
		* FIFO 収録中の要求応答パケットは通知されない。
		*/
		addSensorDataListener(listener) {
			if (typeof listener !== "function") throw new TypeError("OrpheInsole.addSensorDataListener expects a function");
			this.sensorDataListeners.add(listener);
			if (!this.detachSensorData) this.detachSensorData = this.device.onRaw((uuid, data) => this.emitSensorData(uuid, data));
			return () => this.removeSensorDataListener(listener);
		}
		removeSensorDataListener(listener) {
			const removed = this.sensorDataListeners.delete(listener);
			if (this.sensorDataListeners.size === 0 && this.detachSensorData) {
				this.detachSensorData();
				this.detachSensorData = null;
			}
			return removed;
		}
		emitSensorData(uuid, data) {
			if (uuid !== "SENSOR_VALUES" || this.sensorDataListeners.size === 0) return;
			const packet = parseInsoleSensorValues(data, this.profile.sensorParseOptions());
			if (!packet || !REALTIME_HEADERS$1.has(packet.header)) return;
			const event = Object.freeze({
				deviceId: this.id,
				receivedAt: Date.now(),
				packet,
				data
			});
			for (const listener of [...this.sensorDataListeners]) try {
				listener(event);
			} catch (error) {
				this.onError(error);
			}
		}
		/** watchAdvertisements が使える環境でのみ監視を始める */
		async autoStartWatchingAdvertisements() {
			const device = this.bluetoothDevice;
			if (!device || typeof device.watchAdvertisements !== "function") return;
			await this.startWatchingAdvertisements();
		}
		/** advertisement の監視を開始する。受信は onAdvertisementReceived → gotStatus */
		async startWatchingAdvertisements() {
			const device = this.bluetoothDevice;
			if (!device || typeof device.watchAdvertisements !== "function") {
				this._log("watchAdvertisements is not supported on this device/browser");
				return;
			}
			if (!this.advertisementListener) {
				this.advertisementListener = (event) => this.onAdvertisementReceived(event);
				device.addEventListener("advertisementreceived", this.advertisementListener);
			}
			try {
				await device.watchAdvertisements();
				this._log("Started watching advertisements", device.name);
			} catch (error) {
				this.onError(error);
			}
		}
		stopWatchingAdvertisements() {
			const device = this.bluetoothDevice;
			if (device && this.advertisementListener) device.removeEventListener("advertisementreceived", this.advertisementListener);
			this.advertisementListener = null;
		}
		onAdvertisementReceived(event) {
			this.onAdvertisement(event);
			const status = decodeInsoleAdvertisement(event);
			if (!status) return;
			this.lastStatus = status;
			this.gotStatus(status);
		}
		gotStatus(_status) {}
		gotPress(_press) {}
		gotConvertedPress(_press) {}
		gotQuat(_quat) {}
		gotGyro(_gyro) {}
		gotAcc(_acc) {}
		gotConvertedGyro(_gyro) {}
		gotConvertedAcc(_acc) {}
		gotDelta(_delta) {}
		gotEuler(_euler) {}
		onAdvertisement(_event) {}
	};
	//#endregion
	//#region src/compat/insole-modules.ts
	function hostDevice(host) {
		return host instanceof LegacyDevice ? host.device : host;
	}
	var OrpheInsoleFifo = class extends FifoRecorder {
		static FRAME_INTERVAL_MS = FIFO_FRAME_INTERVAL_MS;
		static IMU_ODR_HZ = 208;
		static LEGACY_CSV_FRAME_INTERVAL_MS = 5;
		static CSV_HEADER = FIFO_CSV_HEADER;
		static RING_BUFFER_CAPACITY = FIFO_RING_BUFFER_CAPACITY;
		/** 渡された互換インスタンス（または OrpheCoreInsole） */
		insole;
		constructor(insole, options = {}) {
			super(hostDevice(insole), options);
			this.insole = insole;
		}
	};
	var OrpheInsoleGait = class extends InsoleGait {
		static CSV_HEADER = GAIT_CSV_HEADER;
		/** 渡された互換インスタンス（または OrpheCoreInsole） */
		insole;
		constructor(insole, _options = {}) {
			super(hostDevice(insole));
			this.insole = insole;
		}
	};
	//#endregion
	//#region src/simulator/synthetic.ts
	var SENSOR_COUNT$1 = 6;
	var MAX_UINT16$1 = 65535;
	var SYNTHETIC_SENSOR_LAYOUT = [
		{
			x: -.18,
			y: .42
		},
		{
			x: -.1,
			y: .18
		},
		{
			x: .14,
			y: .38
		},
		{
			x: .02,
			y: .1
		},
		{
			x: .18,
			y: -.06
		},
		{
			x: -.02,
			y: -.42
		}
	];
	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}
	function finiteNumber(value, fallback = 0) {
		const number = Number(value);
		return Number.isFinite(number) ? number : fallback;
	}
	function deterministicNoise(seed, amp) {
		return Math.sin(seed * 12.9898 + 78.233) * amp;
	}
	function bump(phase, center, width) {
		let distance = Math.abs(phase - center);
		if (distance > .5) distance = 1 - distance;
		return Math.exp(-(distance * distance) / (2 * width * width));
	}
	function eulerToQuat(pitch, roll, yaw) {
		const cp = Math.cos(pitch / 2);
		const sp = Math.sin(pitch / 2);
		const cr = Math.cos(roll / 2);
		const sr = Math.sin(roll / 2);
		const cy = Math.cos(yaw / 2);
		const sy = Math.sin(yaw / 2);
		return {
			w: cy * cr * cp + sy * sr * sp,
			x: cy * cr * sp - sy * sr * cp,
			y: cy * sr * cp + sy * cr * sp,
			z: sy * cr * cp - cy * sr * sp
		};
	}
	function cloneVector3(value) {
		if (!value) return null;
		return {
			x: finiteNumber(value.x),
			y: finiteNumber(value.y),
			z: finiteNumber(value.z)
		};
	}
	function cloneQuat(value) {
		if (!value) return null;
		return {
			w: finiteNumber(value.w, 1),
			x: finiteNumber(value.x),
			y: finiteNumber(value.y),
			z: finiteNumber(value.z)
		};
	}
	function cloneEuler(value) {
		if (!value) return null;
		return {
			pitch: finiteNumber(value.pitch),
			roll: finiteNumber(value.roll),
			yaw: finiteNumber(value.yaw)
		};
	}
	function normalizePress(values) {
		if (!Array.isArray(values)) return null;
		const press = values.slice(0, SENSOR_COUNT$1).map((value) => clamp(Math.round(finiteNumber(value)), 0, MAX_UINT16$1));
		while (press.length < SENSOR_COUNT$1) press.push(0);
		return press;
	}
	function generateFootPressureFromTarget(localTarget, targetLoad, phase) {
		const sigmaX = .17;
		const sigmaY = .27;
		const weights = SYNTHETIC_SENSOR_LAYOUT.map((sensor, index) => {
			const dx = (sensor.x - localTarget.x) / sigmaX;
			const dy = (sensor.y - localTarget.y) / sigmaY;
			const pulse = .04 * Math.sin(phase + index * 1.73);
			return .12 + Math.exp(-.5 * (dx * dx + dy * dy)) + pulse;
		});
		const sum = weights.reduce((total, value) => total + Math.max(.01, value), 0);
		return weights.map((weight, index) => {
			const breathing = 1 + .025 * Math.sin(phase * .7 + index);
			return Math.max(0, Math.round(targetLoad * Math.max(.01, weight) / sum * breathing));
		});
	}
	function generateWalkFrame(id, timeMs) {
		const cycleMs = 1200;
		const mirror = id !== 0;
		const phase = (timeMs % cycleMs / cycleMs + (mirror ? .5 : 0)) % 1;
		const sideSign = mirror ? -1 : 1;
		const stance = .6;
		const noise = (seed, amp) => deterministicNoise(timeMs * .001 + seed + id * 17, amp);
		const press = [
			7600 * bump(phase, .52, .09),
			12e3 * bump(phase, .42, .12),
			5800 * bump(phase, .48, .09),
			10500 * bump(phase, .38, .12),
			6400 * bump(phase, .25, .14),
			13500 * bump(phase, .12, .11)
		].map((value, index) => clamp(Math.round(value + noise(index, 90)), 0, MAX_UINT16$1));
		const impact = 1.6 * bump(phase, .03, .02);
		const acc = {
			x: sideSign * .25 * Math.sin(2 * Math.PI * phase) + noise(10, .03),
			y: .12 * Math.sin(2 * Math.PI * phase * 2 + 1) + noise(11, .03),
			z: 1 + impact + .18 * Math.sin(2 * Math.PI * phase * 2) + noise(12, .04)
		};
		const swing = phase > stance ? Math.sin(Math.PI * (phase - stance) / .4) : 0;
		const gyro = {
			x: sideSign * 30 * Math.sin(2 * Math.PI * phase * 2) + noise(20, 8),
			y: 380 * swing - 90 * bump(phase, .55, .05) + noise(21, 8),
			z: sideSign * 20 * Math.sin(2 * Math.PI * phase + 2) + noise(22, 8)
		};
		const pitch = -.45 * bump(phase, .62, .07) + .3 * bump(phase, .82, .1);
		const roll = sideSign * (.08 * Math.sin(2 * Math.PI * phase) + .02 * Math.sin(timeMs / 900));
		const yaw = sideSign * .06 * Math.sin(timeMs / 1500);
		const euler = {
			pitch,
			roll,
			yaw
		};
		return {
			press,
			acc,
			gyro,
			quat: eulerToQuat(pitch, roll, yaw),
			euler
		};
	}
	function generateSwayFrame(id, timeMs, standStill) {
		const timeSeconds = timeMs / 1e3;
		const sideSign = id === 0 ? -1 : 1;
		const swayScale = standStill ? .3 : 1;
		const swayX = swayScale * (.035 * Math.sin(timeSeconds * 1.15) + .014 * Math.sin(timeSeconds * 3.2 + .8));
		const swayY = swayScale * (.055 * Math.sin(timeSeconds * .82 + .5) + .015 * Math.sin(timeSeconds * 2.6));
		const press = generateFootPressureFromTarget({
			x: clamp(swayX * sideSign * .42, -.16, .16),
			y: clamp(swayY, -.42, .42)
		}, ((standStill ? 5200 : 6200) + (standStill ? 80 : 260) * Math.sin(timeSeconds * .45)) / 2, timeSeconds + id * 1.1);
		const acc = {
			x: swayX * .4,
			y: swayY * .25,
			z: 1 + .015 * Math.sin(timeSeconds * 1.4 + id)
		};
		const gyro = {
			x: 3.5 * Math.sin(timeSeconds * 1.1 + id),
			y: 5.5 * Math.sin(timeSeconds * .9),
			z: 2.5 * Math.sin(timeSeconds * 1.6 + id * .5)
		};
		const euler = {
			pitch: swayY * .14,
			roll: sideSign * swayX * .16,
			yaw: sideSign * .01 * Math.sin(timeSeconds * .6)
		};
		return {
			press,
			acc,
			gyro,
			quat: eulerToQuat(euler.pitch, euler.roll, euler.yaw),
			euler
		};
	}
	function generatedFrame(id, preset, timeMs) {
		if (preset === "stand") return generateSwayFrame(id, timeMs, true);
		if (preset === "sway") return generateSwayFrame(id, timeMs, false);
		return generateWalkFrame(id, timeMs);
	}
	//#endregion
	//#region src/compat/insole-simulator.ts
	var ACC_RANGE = 16;
	var GYRO_NORMALIZE_FULL_SCALE = 2e3 * 35e-6 * 32768;
	var TICK_MS$1 = 20;
	var SENSOR_VALUES_UUID = "SENSOR_VALUES";
	function normalizeVector3(value, range) {
		if (!value) return null;
		return {
			x: value.x / range,
			y: value.y / range,
			z: value.z / range
		};
	}
	function withSampleMeta(value, timestamp, serialNumber, packetNumber) {
		return Object.assign({}, value, {
			timestamp,
			serial_number: serialNumber,
			packet_number: packetNumber
		});
	}
	function normalizeStreamingMode(value) {
		const mode = value === void 0 || value === null ? 4 : Number(value);
		if (mode === 1 || mode === 3 || mode === 4) return mode;
		throw new TypeError("Invalid ORPHE INSOLE simulator streaming mode");
	}
	function samplesPerTick(streamingMode) {
		return streamingMode === 4 ? 2 : 4;
	}
	function normalizeBeginArgs(type, options) {
		if (type && typeof type === "object") return Object.assign({}, type);
		return Object.assign({}, options || {});
	}
	function defaultDeviceInformation(id) {
		return {
			battery: 2,
			mount_position: id === 0 ? 0 : 1,
			range: {
				acc: 3,
				gyro: 3
			}
		};
	}
	var OrpheInsoleSimulator = class {
		/** デバイス番号。0 は左足、それ以外は右足として合成データを作る */
		id;
		debug = false;
		/** begin() または getDeviceInformation() で設定される。それまでは null */
		device_information = null;
		/** 加速度（-1..1 の正規化値） */
		acc = null;
		/** 角速度（-1..1 の正規化値） */
		gyro = null;
		quat = null;
		euler = null;
		/** 6ch 圧力の生値 */
		press = null;
		/** 加速度 [G] */
		converted_acc = null;
		/** 角速度 [dps] */
		converted_gyro = null;
		interpolation = {
			enabled: false,
			max_consecutive_missing: 1
		};
		_timer = null;
		_connected = false;
		_serial = 0;
		_sampleIndex = 0;
		_startedAt = 0;
		_streamingMode = 4;
		_preset = "walk";
		_frames = null;
		_frameIndex = 0;
		_loop = true;
		_sensorDataListeners = /* @__PURE__ */ new Set();
		constructor(id = 0) {
			this.id = id;
		}
		/** OrpheInsole と同じ初期化。補間設定を保持するだけで、シミュレータの出力には影響しない */
		setup(names = [
			"DEVICE_INFORMATION",
			"DATE_TIME",
			"SENSOR_VALUES"
		], options = {}) {
			const defaultInterpolation = {
				enabled: false,
				max_consecutive_missing: 1
			};
			const interpolation = options && typeof options.interpolation === "object" ? options.interpolation : {};
			this.names = Array.isArray(names) ? names.slice() : [names];
			this.interpolation = Object.assign({}, defaultInterpolation, interpolation);
			return this;
		}
		/**
		* 配送を開始する。onScan → onConnect → onStartNotify の順に呼んだあと、
		* 最初の tick を同期的に配送する。
		* 失敗は onError に報告したうえで reject する。
		*/
		async begin(type, options) {
			try {
				const beginOptions = normalizeBeginArgs(type, options);
				this.stop({ silent: true });
				this._streamingMode = normalizeStreamingMode(beginOptions.streamingMode);
				this.streaming_mode = this._streamingMode;
				this._preset = beginOptions.preset === "stand" || beginOptions.preset === "sway" ? beginOptions.preset : "walk";
				this._frames = this._normalizeFrames(beginOptions.frames);
				this._loop = beginOptions.loop !== false;
				this._frameIndex = 0;
				this._sampleIndex = 0;
				this._serial = 0;
				this._startedAt = this._now();
				this.device_information = defaultDeviceInformation(this.id);
				this._connected = true;
				this.onScan(`ORPHE INSOLE Simulator ${this.id}`);
				this.onConnect("SIMULATOR");
				this.onStartNotify(SENSOR_VALUES_UUID);
				this._timer = setInterval(() => this._tick(), TICK_MS$1);
				this._tick();
				return "done begin(); SENSOR VALUES";
			} catch (error) {
				this.onError(error);
				throw error;
			}
		}
		/** 配送を止める。接続中だった場合は onDisconnect を呼ぶ（silent: true なら呼ばない） */
		stop(options = {}) {
			if (this._timer) {
				clearInterval(this._timer);
				this._timer = null;
			}
			const wasConnected = this._connected;
			this._connected = false;
			if (wasConnected && !options.silent) this.onDisconnect();
			return "done stop();";
		}
		/** 配送を止め、最新値と連番をクリアして onReset を呼ぶ */
		reset() {
			this.stop();
			this._serial = 0;
			this._sampleIndex = 0;
			this._frameIndex = 0;
			this.acc = null;
			this.gyro = null;
			this.quat = null;
			this.euler = null;
			this.press = null;
			this.converted_acc = null;
			this.converted_gyro = null;
			this.onReset();
		}
		/**
		* パケット単位（1 tick 分のサンプル列）のリスナーを登録する。
		* @returns 登録解除関数
		*/
		addSensorDataListener(listener) {
			if (typeof listener !== "function") throw new TypeError("OrpheInsoleSimulator.addSensorDataListener expects a function");
			this._sensorDataListeners.add(listener);
			return () => this.removeSensorDataListener(listener);
		}
		/** addSensorDataListener() で登録したリスナーを外す */
		removeSensorDataListener(listener) {
			return this._sensorDataListeners.delete(listener);
		}
		isConnected() {
			return this._connected;
		}
		/**
		* ストリーミングモードを切り替える。
		* 実行中でも次 tick から新モードのデータ有無・サンプル数が反映される。
		* 不正なモードは OrpheInsole と同じメッセージで onError に報告したうえで reject する。
		*/
		async setDataStreamingMode(mode) {
			const normalized = Number(mode);
			if (normalized !== 1 && normalized !== 3 && normalized !== 4) {
				const error = /* @__PURE__ */ new TypeError("Invalid ORPHE INSOLE data streaming mode");
				this.onError(error);
				throw error;
			}
			this._streamingMode = normalized;
			this.streaming_mode = normalized;
		}
		/** デバイス情報を返す。begin 前でも既定値を返す */
		async getDeviceInformation() {
			if (!this.device_information) this.device_information = defaultDeviceInformation(this.id);
			return this.device_information;
		}
		/** シミュレータでは固定文字列 "simulator" を返す */
		async getFirmwareVersion() {
			return "simulator";
		}
		/** シミュレータに解析ログはないので何もしない */
		resetAnalysisLogs() {}
		_normalizeFrames(frames) {
			if (!Array.isArray(frames) || frames.length === 0) return null;
			const list = frames;
			const matching = list.filter((frame) => frame && (frame.device === void 0 || Number(frame.device) === Number(this.id)));
			return (matching.length > 0 ? matching : list).slice();
		}
		_now() {
			const perf = globalThis.performance;
			if (perf && typeof perf.now === "function") return perf.now();
			return Date.now();
		}
		_tick() {
			if (!this._connected) return;
			this.gotBLEFrequency(50);
			const count = samplesPerTick(this._streamingMode);
			const interval = TICK_MS$1 / count;
			const tickTime = this._now() - this._startedAt;
			const serialNumber = this._serial;
			this._serial = (this._serial + 1) % 65536;
			const packetSamples = [];
			for (let packetNumber = 0; packetNumber < count; packetNumber++) {
				const timestamp = Math.round(tickTime + packetNumber * interval);
				const frame = this._nextFrame(timestamp);
				if (!frame) {
					this.stop();
					return;
				}
				const frameSerial = frame.serial === void 0 ? serialNumber : finiteNumber(frame.serial, serialNumber);
				const framePacketNumber = frame.packet_number === void 0 ? packetNumber : finiteNumber(frame.packet_number, packetNumber);
				packetSamples.push(this._dispatchFrame(frame, timestamp, frameSerial, framePacketNumber));
				this._sampleIndex += 1;
			}
			if (this._sensorDataListeners.size > 0) {
				const packet = {
					header: this._streamingMode === 4 ? 56 : this._streamingMode === 1 ? 50 : 55,
					serial_number: serialNumber,
					timestamp: Math.round(tickTime),
					samples: packetSamples
				};
				const event = Object.freeze({
					deviceId: this.id,
					receivedAt: Date.now(),
					packet,
					data: null
				});
				for (const listener of Array.from(this._sensorDataListeners)) try {
					listener(event);
				} catch (error) {
					this.onError(error);
				}
			}
		}
		_nextFrame(timestamp) {
			if (!this._frames) return generatedFrame(this.id, this._preset, timestamp);
			if (this._frameIndex >= this._frames.length) {
				if (!this._loop) return null;
				this._frameIndex = 0;
			}
			const frame = this._frames[this._frameIndex];
			this._frameIndex += 1;
			return frame;
		}
		_dispatchFrame(frame, timestamp, serialNumber, packetNumber) {
			const frameTimestamp = frame.t === void 0 ? timestamp : finiteNumber(frame.t, timestamp);
			const convertedAcc = cloneVector3(frame.acc);
			const convertedGyro = cloneVector3(frame.gyro);
			const normalizedAcc = normalizeVector3(convertedAcc, ACC_RANGE);
			const normalizedGyro = normalizeVector3(convertedGyro, GYRO_NORMALIZE_FULL_SCALE);
			const quat = cloneQuat(frame.quat);
			const euler = cloneEuler(frame.euler);
			const pressValues = normalizePress(frame.press);
			if (normalizedAcc) {
				this.acc = withSampleMeta(normalizedAcc, frameTimestamp, serialNumber, packetNumber);
				this.gotAcc(this.acc);
			}
			if (normalizedGyro) {
				this.gyro = withSampleMeta(normalizedGyro, frameTimestamp, serialNumber, packetNumber);
				this.gotGyro(this.gyro);
			}
			if (convertedAcc) {
				this.converted_acc = withSampleMeta(convertedAcc, frameTimestamp, serialNumber, packetNumber);
				this.gotConvertedAcc(this.converted_acc);
			}
			if (convertedGyro) {
				this.converted_gyro = withSampleMeta(convertedGyro, frameTimestamp, serialNumber, packetNumber);
				this.gotConvertedGyro(this.converted_gyro);
			}
			if (this._streamingMode !== 3 && quat) {
				this.quat = withSampleMeta(quat, frameTimestamp, serialNumber, packetNumber);
				this.gotQuat(this.quat);
				if (euler) {
					this.euler = withSampleMeta(euler, frameTimestamp, serialNumber, packetNumber);
					this.gotEuler(this.euler);
				}
			}
			if (this._streamingMode !== 1 && pressValues) {
				this.press = {
					values: pressValues,
					timestamp: frameTimestamp,
					serial_number: serialNumber,
					packet_number: packetNumber
				};
				this.gotPress(this.press);
			}
			return {
				timestamp: frameTimestamp,
				serial_number: serialNumber,
				packet_number: packetNumber,
				...this.quat && this._streamingMode !== 3 ? { quat: { ...this.quat } } : {},
				...this.gyro ? { gyro: { ...this.gyro } } : {},
				...this.acc ? { acc: { ...this.acc } } : {},
				...this.converted_gyro ? { converted_gyro: { ...this.converted_gyro } } : {},
				...this.converted_acc ? { converted_acc: { ...this.converted_acc } } : {},
				...this.press && this._streamingMode !== 1 ? { press: {
					...this.press,
					values: [...this.press.values]
				} } : {}
			};
		}
		gotPress(_press) {}
		gotAcc(_acc) {}
		gotGyro(_gyro) {}
		gotQuat(_quat) {}
		gotEuler(_euler) {}
		gotConvertedAcc(_acc) {}
		gotConvertedGyro(_gyro) {}
		gotBLEFrequency(_frequency) {}
		/** シミュレータでは欠損が起きないので呼ばれない */
		lostData(_serialNumber, _serialNumberPrev) {}
		onConnect(_uuid) {}
		onDisconnect() {}
		onError(_error) {}
		onScan(_deviceName) {}
		onStartNotify(_uuid) {}
		onReset() {}
	};
	//#endregion
	//#region src/simulator/insole-packet.ts
	var INT16_MIN = -32768;
	var INT16_MAX = 32767;
	function int16(value) {
		return Math.min(INT16_MAX, Math.max(INT16_MIN, Math.round(Number.isFinite(value) ? value : 0)));
	}
	function uint16(value) {
		return Math.min(65535, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
	}
	/** header ごとのサンプル数 */
	function insolePacketFrameCount(header) {
		return header === 56 ? 2 : 4;
	}
	/** 物理値のサンプル列から SENSOR_VALUES パケットを作る */
	function encodeInsoleSensorValues(input) {
		const data = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(104));
		const accRange = input.accRange ?? 16;
		const gyroDpsPerLsb = (input.gyroRange ?? 2e3) * 35e-6;
		const count = insolePacketFrameCount(input.header);
		data.setUint8(0, input.header);
		data.setUint16(1, input.serial & 65535);
		data.setUint8(3, input.time.getHours());
		data.setUint8(4, input.time.getMinutes());
		data.setUint8(5, input.time.getSeconds());
		data.setUint16(6, input.time.getMilliseconds());
		const vec = (offset, value, toRaw) => {
			data.setInt16(offset, int16(toRaw(value?.x ?? 0)));
			data.setInt16(offset + 2, int16(toRaw(value?.y ?? 0)));
			data.setInt16(offset + 4, int16(toRaw(value?.z ?? 0)));
		};
		const accRaw = (g) => g / accRange * 32768;
		const gyroRaw = (dps) => dps / gyroDpsPerLsb;
		const quat = (offset, value) => {
			data.setInt16(offset, int16((value?.w ?? 1) * 16384));
			data.setInt16(offset + 2, int16((value?.x ?? 0) * 16384));
			data.setInt16(offset + 4, int16((value?.y ?? 0) * 16384));
			data.setInt16(offset + 6, int16((value?.z ?? 0) * 16384));
		};
		const press = (offset, values) => {
			for (let ch = 0; ch < 6; ch++) data.setUint16(offset + ch * 2, uint16(values?.[ch] ?? 0));
		};
		for (let k = 0; k < count; k++) {
			const frame = input.frames[k] ?? {};
			if (input.header === 50) {
				const i = 3 - k;
				const base = 8 + 21 * i;
				quat(base, frame.quat);
				vec(base + 8, frame.gyro, gyroRaw);
				vec(base + 14, frame.acc, accRaw);
				if (i !== 3) data.setUint8(28 + 21 * i, input.intervalMs ?? 5);
			} else if (input.header === 55) {
				const base = 8 + 24 * (3 - k);
				vec(base, frame.gyro, gyroRaw);
				vec(base + 6, frame.acc, accRaw);
				press(base + 12, frame.press);
			} else {
				const base = 8 + 32 * (1 - k);
				quat(base, frame.quat);
				vec(base + 8, frame.gyro, gyroRaw);
				vec(base + 14, frame.acc, accRaw);
				press(base + 20, frame.press);
			}
		}
		return data;
	}
	//#endregion
	//#region src/simulator/insole-simulator.ts
	var TICK_MS = 20;
	/** タイマーが遅れたときに 1 回の tick でまとめて送る最大パケット数（タブが裏に回った後の暴発を防ぐ） */
	var MAX_CATCH_UP_PACKETS = 25;
	/** 擬似 characteristic */
	var SimCharacteristic = class {
		listeners = /* @__PURE__ */ new Set();
		value = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(20));
		onWrite = null;
		onNotify = null;
		async readValue() {
			return this.value;
		}
		async writeValue(data) {
			const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			this.onWrite?.(new Uint8Array(bytes));
		}
		async startNotifications() {
			this.onNotify?.(true);
			return this;
		}
		async stopNotifications() {
			this.onNotify?.(false);
			return this;
		}
		addEventListener(_type, listener) {
			this.listeners.add(listener);
		}
		removeEventListener(_type, listener) {
			this.listeners.delete(listener);
		}
		emit(value) {
			for (const listener of [...this.listeners]) listener({ target: { value } });
		}
	};
	/** 擬似 INSOLE デバイス（GATT サーバと 20ms ごとの notify を持つ） */
	var SimInsoleDevice = class {
		id;
		name;
		connected = false;
		listeners = /* @__PURE__ */ new Map();
		services;
		sensor = new SimCharacteristic();
		options;
		slot;
		streamingMode = 4;
		timer = null;
		serial = 0;
		startedAt = 0;
		sentPackets = 0;
		frameIndex = 0;
		frames;
		constructor(slot, options) {
			this.slot = slot;
			this.options = options;
			this.id = `insole-simulator-${slot}`;
			this.name = `INS-SIM-${slot}`;
			const list = options.frames && options.frames.length > 0 ? [...options.frames] : null;
			const matching = list?.filter((frame) => frame.device === void 0 || Number(frame.device) === slot) ?? null;
			this.frames = matching && matching.length > 0 ? matching : list;
			const info = new SimCharacteristic();
			const infoData = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(20));
			infoData.setUint8(0, options.battery ?? 2);
			infoData.setUint8(1, options.mountPosition ?? (slot === 0 ? 0 : 1));
			infoData.setUint8(8, 3);
			infoData.setUint8(9, 3);
			info.value = infoData;
			info.onWrite = (bytes) => {
				if (bytes[0] === DEVICE_INFORMATION_OPCODE.SET_STREAMING_MODE && [
					1,
					3,
					4
				].includes(bytes[1] ?? 0)) this.streamingMode = bytes[1];
			};
			const dateTime = new SimCharacteristic();
			dateTime.value = new DataView(encodeDateTime(/* @__PURE__ */ new Date()).buffer);
			dateTime.onWrite = () => {
				dateTime.value = new DataView(encodeDateTime(/* @__PURE__ */ new Date()).buffer);
			};
			this.sensor.onNotify = (on) => on ? this.startStreaming() : this.stopStreaming();
			this.services = {
				[ORPHE_UUID.INFORMATION_SERVICE]: {
					[ORPHE_UUID.DEVICE_INFORMATION]: info,
					[ORPHE_UUID.DATE_TIME]: dateTime
				},
				[ORPHE_UUID.OTHER_SERVICE]: { [ORPHE_UUID.SENSOR_VALUES]: this.sensor }
			};
		}
		get gatt() {
			return this;
		}
		async connect() {
			this.connected = true;
			return this;
		}
		disconnect() {
			if (!this.connected) return;
			this.connected = false;
			this.stopStreaming();
			this.dispatch("gattserverdisconnected", {});
		}
		async getPrimaryService(uuid) {
			if (!this.connected) throw new Error("GATT Server is disconnected.");
			const service = this.services[uuid];
			if (!service) throw new Error(`Simulator: service ${uuid} not found`);
			return { async getCharacteristic(characteristicUUID) {
				const characteristic = service[characteristicUUID];
				if (!characteristic) throw new Error(`Simulator: characteristic ${characteristicUUID} not found`);
				return characteristic;
			} };
		}
		addEventListener(type, listener) {
			let set = this.listeners.get(type);
			if (!set) {
				set = /* @__PURE__ */ new Set();
				this.listeners.set(type, set);
			}
			set.add(listener);
		}
		removeEventListener(type, listener) {
			this.listeners.get(type)?.delete(listener);
		}
		dispatch(type, event) {
			for (const listener of [...this.listeners.get(type) ?? []]) listener(event);
		}
		startStreaming() {
			if (this.timer) return;
			this.startedAt = Date.now();
			this.sentPackets = 0;
			this.frameIndex = 0;
			this.timer = setInterval(() => this.tick(), TICK_MS);
		}
		stopStreaming() {
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
		}
		nextFrame(timeMs) {
			if (!this.frames) return generatedFrame(this.slot, this.options.preset ?? "walk", timeMs);
			if (this.frameIndex >= this.frames.length) {
				if (this.options.loop === false) return null;
				this.frameIndex = 0;
			}
			return this.frames[this.frameIndex++] ?? null;
		}
		/**
		* 経過時間ぶんのパケットを送る。ブラウザがタイマーを間引いても（裏タブ・高負荷）、
		* 実機と同じ 50 パケット/秒になるよう遅れた分をまとめて送る。
		*/
		tick() {
			const due = Math.floor((Date.now() - this.startedAt) / TICK_MS) + 1;
			let count = Math.min(due - this.sentPackets, MAX_CATCH_UP_PACKETS);
			if (due - this.sentPackets > MAX_CATCH_UP_PACKETS) this.sentPackets = due - count;
			while (count-- > 0 && this.timer) {
				this.sendPacket(this.sentPackets * TICK_MS);
				this.sentPackets++;
			}
		}
		sendPacket(packetTimeMs) {
			if (!this.connected) return;
			const header = this.streamingMode === 1 ? 50 : this.streamingMode === 3 ? 55 : 56;
			const count = insolePacketFrameCount(header);
			const frames = [];
			for (let k = 0; k < count; k++) {
				const frame = this.nextFrame(packetTimeMs + k * TICK_MS / count);
				if (!frame) {
					this.disconnect();
					return;
				}
				frames.push(frame);
			}
			this.sensor.emit(encodeInsoleSensorValues({
				header,
				serial: this.serial,
				time: new Date(this.startedAt + packetTimeMs),
				frames,
				intervalMs: TICK_MS / count
			}));
			this.serial = (this.serial + 1) % 65536;
		}
	};
	/**
	* 擬似 INSOLE を返す Web Bluetooth 実装。OrpheCoreInsole の `bluetooth` オプションに渡す。
	* chooser は開かず、常に同じ擬似デバイスを返す。
	*/
	function insoleSimulatorBluetooth(slot = 0, options = {}) {
		const device = new SimInsoleDevice(slot, options);
		return {
			async requestDevice() {
				return device;
			},
			async getDevices() {
				return [device];
			}
		};
	}
	/** メモリ上だけの記憶デバイス保存先（シミュレータは localStorage を汚さない） */
	var SimulatorStorage = class {
		map = /* @__PURE__ */ new Map();
		getItem(key) {
			return this.map.get(key) ?? null;
		}
		setItem(key, value) {
			this.map.set(key, value);
		}
		removeItem(key) {
			this.map.delete(key);
		}
	};
	/**
	* 擬似 INSOLE につながった OrpheCoreInsole を作る。実機の代わりにそのまま使える。
	*
	* @param slot スロット番号（0 は左足、それ以外は右足として合成データを作る）
	* @param options 合成データ・再生フレーム・デバイス情報の設定
	* @param deviceOptions OrpheCoreInsole へ渡すオプション（events / log / profile のオプションなど）
	*/
	function createInsoleSimulator(slot = 0, options = {}, deviceOptions = {}) {
		const { profile: profileOptions, ...rest } = deviceOptions;
		return new OrpheCoreInsole({
			storage: new SimulatorStorage(),
			...rest,
			id: slot,
			profile: insoleProfile({
				timeSyncSamples: 1,
				...profileOptions,
				pressureCalibration: { fetch: false }
			}),
			bluetooth: insoleSimulatorBluetooth(slot, options)
		});
	}
	/** ADC 生値の上限（uint16） */
	var MAX_UINT16 = 65535;
	/**
	* 6ch 圧力センサのインソール画像上マーカー座標（0..1 の画像比率・実機採寸値）。
	* チャネルの物理配置はモデルによって異なる場合があるため、
	* 配置が異なるモデルでは同形式の配列でリマップ層を挟むこと。
	*/
	var SENSOR_LAYOUT_IMAGE = [
		{
			x: .7596,
			y: .168,
			label: "P0"
		},
		{
			x: .7513,
			y: .332,
			label: "P1"
		},
		{
			x: .4024,
			y: .221,
			label: "P2"
		},
		{
			x: .5245,
			y: .3483,
			label: "P3"
		},
		{
			x: .2884,
			y: .3681,
			label: "P4"
		},
		{
			x: .5552,
			y: .8206,
			label: "P5"
		}
	];
	var FOOT_LOCAL_X_RANGE = .58;
	var FOOT_LOCAL_Y_RANGE = .9;
	/**
	* 6ch 圧力センサの足ローカル座標系レイアウト（SENSOR_LAYOUT_IMAGE から導出。右足基準）。
	* x: 内外方向 / y: 前後方向（+がつま先側）。単位は足長を約1とする無次元。
	* 左足には mirrorForSide() で左右反転したものを使う。
	*/
	var SENSOR_LAYOUT = SENSOR_LAYOUT_IMAGE.map((sensor) => ({
		x: (sensor.x - .5) * FOOT_LOCAL_X_RANGE,
		y: (.5 - sensor.y) * FOOT_LOCAL_Y_RANGE,
		label: sensor.label
	}));
	/**
	* レイアウトを左右反転した新しい配列を返す（元の配列・要素は変更しない）。
	* SENSOR_LAYOUT は右足基準なので、左足には mirrorForSide(SENSOR_LAYOUT, 'left') を使う。
	*/
	function mirrorForSide(layout, side) {
		const mirror = side === "left";
		return layout.map((sensor) => Object.assign({}, sensor, { x: mirror ? -sensor.x : sensor.x }));
	}
	/**
	* 圧力生値の単一フレーム検証。
	* flags:
	* - BAD_LENGTH   配列でない・6ch 未満（値は 0 埋めで補完される）
	* - NOT_FINITE   NaN / Infinity / 数値化不能（0 に置換される）
	* - NEGATIVE     負値（0 にクランプされる）
	* - SATURATED_CH 飽和値（既定 65535 = uint16 上限）に張り付いたチャネルあり
	*
	* 「0 張り付き（断線疑い）」は時間履歴が必要なため StuckChannelMonitor を使うこと。
	* 元の配列は変更しない。
	*/
	function validatePress(values, options) {
		const saturationValue = options && options.saturationValue || 65535;
		const flags = [];
		const saturated = [];
		if (!Array.isArray(values) || values.length < 6) flags.push("BAD_LENGTH");
		const source = Array.isArray(values) ? values : [];
		const sanitized = [];
		for (let i = 0; i < 6; i++) {
			const numberValue = Number(source[i]);
			if (!Number.isFinite(numberValue)) {
				if (i < source.length) flags.push("NOT_FINITE");
				sanitized.push(0);
				continue;
			}
			if (numberValue < 0) {
				flags.push("NEGATIVE");
				sanitized.push(0);
				continue;
			}
			if (numberValue >= saturationValue) {
				saturated.push(i);
				sanitized.push(saturationValue);
				continue;
			}
			sanitized.push(numberValue);
		}
		if (saturated.length > 0) flags.push("SATURATED_CH");
		return {
			ok: flags.length === 0,
			values: sanitized,
			flags: Array.from(new Set(flags)),
			channels: { saturated }
		};
	}
	/**
	* 「0 張り付き」チャネル（断線・接触不良疑い）の監視。
	* 足全体に荷重が乗っているのに特定チャネルだけ 0 が続く状態を検出する。
	* 単一フレームでは踵上げ等と区別できないため、時間窓で判定する。
	*
	* ```js
	* const monitor = new StuckChannelMonitor({ windowFrames: 200, minTotalLoad: 1000 });
	* insole.gotPress = (press) => {
	*   const stuck = monitor.update(press.values);
	*   if (stuck.length) console.warn('stuck channels:', stuck);
	* };
	* ```
	*/
	var StuckChannelMonitor = class {
		windowFrames;
		minTotalLoad;
		_zeroStreak = [];
		constructor(options) {
			const opts = options || {};
			const windowFrames = opts.windowFrames;
			const minTotalLoad = opts.minTotalLoad;
			this.windowFrames = windowFrames !== void 0 && windowFrames > 0 ? windowFrames : 200;
			this.minTotalLoad = minTotalLoad !== void 0 && minTotalLoad >= 0 ? minTotalLoad : 1e3;
			this.reset();
		}
		/** 張り付きカウントをリセットする */
		reset() {
			this._zeroStreak = new Array(6).fill(0);
		}
		/**
		* 1 フレーム分の生値を渡す。
		* @returns 張り付きと判定されたチャネル番号の配列（なければ空配列）
		*/
		update(values) {
			const validated = validatePress(values);
			const total = validated.values.reduce((sum, value) => sum + value, 0);
			const stuck = [];
			for (let i = 0; i < 6; i++) {
				if (total >= this.minTotalLoad) this._zeroStreak[i] = validated.values[i] === 0 ? this._zeroStreak[i] + 1 : 0;
				if (this._zeroStreak[i] >= this.windowFrames) stuck.push(i);
			}
			return stuck;
		}
	};
	/**
	* 2点キャリブレーション（無負荷時・全体重時）による 0..1 正規化。
	*
	* ```js
	* const calib = new PressureCalibrator();
	* calib.setZero(zeroSamples);  // 無負荷で 1〜2 秒分の press.values を集めて渡す
	* calib.setFull(fullSamples);  // 全体重で同様
	* const normalized = calib.normalize(press.values); // 各ch 0..1
	* ```
	*/
	var PressureCalibrator = class PressureCalibrator {
		/** 無負荷時の各チャネル平均 */
		zero = new Array(6).fill(0);
		/** 全体重時の各チャネル平均 */
		full = new Array(6).fill(MAX_UINT16);
		_zeroSet = false;
		_fullSet = false;
		/** setZero と setFull の両方が済んでいるか */
		isCalibrated() {
			return this._zeroSet && this._fullSet;
		}
		/** 無負荷時の press.values の配列を渡す */
		setZero(samples) {
			this.zero = averageChannels(samples);
			this._zeroSet = true;
		}
		/** 全体重時の press.values の配列を渡す */
		setFull(samples) {
			this.full = averageChannels(samples);
			this._fullSet = true;
		}
		/**
		* 生値を正規化する。
		* @returns 各チャネル 0..1 にクランプされた 6 要素配列
		*/
		normalize(values) {
			return validatePress(values).values.map((value, i) => {
				const range = this.full[i] - this.zero[i];
				const normalized = (value - this.zero[i]) / (range + 1e-6);
				return Math.max(0, Math.min(1, normalized));
			});
		}
		/** 保存用（localStorage 等）の形式に変換する */
		toJSON() {
			return {
				zero: this.zero.slice(),
				full: this.full.slice()
			};
		}
		/** toJSON() の出力から復元する。形式が不正なら未キャリブレーションのインスタンスを返す */
		static fromJSON(json) {
			const calibrator = new PressureCalibrator();
			if (json && Array.isArray(json.zero) && Array.isArray(json.full) && json.zero.length >= 6 && json.full.length >= 6) {
				calibrator.zero = json.zero.slice(0, 6).map((value) => {
					return Number.isFinite(Number(value)) ? Number(value) : 0;
				});
				calibrator.full = json.full.slice(0, 6).map((value) => {
					return Number.isFinite(Number(value)) ? Number(value) : MAX_UINT16;
				});
				calibrator._zeroSet = true;
				calibrator._fullSet = true;
			}
			return calibrator;
		}
	};
	function averageChannels(samples) {
		const sum = new Array(6).fill(0);
		if (!Array.isArray(samples) || samples.length === 0) return sum;
		let count = 0;
		for (const sample of samples) {
			validatePress(sample).values.forEach((value, i) => {
				sum[i] = sum[i] + value;
			});
			count++;
		}
		return sum.map((value) => value / count);
	}
	/**
	* 圧力中心（CoP）を計算する。
	* @param values press.values（生値または正規化値）
	* @param layout センサ座標（既定 SENSOR_LAYOUT = 右足基準。左足は mirrorForSide(SENSOR_LAYOUT, 'left') を渡す）
	* @param options minLoad: これ未満の合計荷重では isValid=false（既定 1）
	*/
	function computeCoP(values, layout, options) {
		const sensors = layout || SENSOR_LAYOUT;
		const minLoad = options && typeof options.minLoad === "number" && options.minLoad >= 0 ? options.minLoad : 1;
		const validated = validatePress(values);
		const flags = validated.flags;
		if (sensors.length < 6) return {
			x: 0,
			y: 0,
			load: 0,
			isValid: false,
			flags: flags.concat("BAD_LAYOUT")
		};
		const load = validated.values.reduce((sum, value) => sum + value, 0);
		if (load < minLoad) return {
			x: 0,
			y: 0,
			load,
			isValid: false,
			flags: flags.concat("LOAD_BELOW_THRESHOLD")
		};
		let copX = 0;
		let copY = 0;
		validated.values.forEach((value, i) => {
			const weight = value / load;
			copX += sensors[i].x * weight;
			copY += sensors[i].y * weight;
		});
		return {
			x: copX,
			y: copY,
			load,
			isValid: validated.ok,
			flags
		};
	}
	/**
	* 接地/離地イベント検出（ヒステリシス + チャタリング除去用の最小継続時間）。
	*
	* ```js
	* const detector = new ContactDetector({ on: 800, off: 400, minContactMs: 50 });
	* detector.footDown = (info) => console.log('down', info.flightMs);
	* detector.footUp = (info) => console.log('up', info.stanceMs);
	* insole.gotPress = (press) => {
	*   const total = press.values.reduce((a, b) => a + b, 0);
	*   detector.update(total, press.timestamp);
	* };
	* ```
	*/
	var ContactDetector = class {
		/** 接地判定しきい値 */
		on;
		/** 離地判定しきい値 */
		off;
		minContactMs;
		minFlightMs;
		/** 接地時コールバック（上書きして使う） */
		footDown;
		/** 離地時コールバック（上書きして使う） */
		footUp;
		/** 現在接地中か */
		isContact = false;
		_lastChange = null;
		/** @throws {TypeError} options.on が options.off より大きくない場合 */
		constructor(options) {
			const opts = options || {};
			if (!(opts.on !== void 0 && opts.off !== void 0 && opts.on > opts.off)) throw new TypeError("ContactDetector: options.on must be greater than options.off");
			const minContactMs = opts.minContactMs;
			const minFlightMs = opts.minFlightMs;
			this.on = opts.on;
			this.off = opts.off;
			this.minContactMs = minContactMs !== void 0 && minContactMs > 0 ? minContactMs : 0;
			this.minFlightMs = minFlightMs !== void 0 && minFlightMs > 0 ? minFlightMs : 0;
			this.footDown = function() {};
			this.footUp = function() {};
			this.reset();
		}
		/** 状態を離地・履歴なしに戻す */
		reset() {
			this.isContact = false;
			this._lastChange = null;
		}
		/**
		* 1 フレーム分の合計荷重を渡す。状態が変わったときだけイベントを返し、対応するコールバックも呼ぶ。
		* @param total 合計荷重（生値または正規化値。on/off と同じ単位で）
		* @param timestampMs タイムスタンプ [ms]（press.timestamp）
		*/
		update(total, timestampMs) {
			const elapsed = this._lastChange === null ? null : timestampMs - this._lastChange;
			if (!this.isContact && total > this.on) {
				if (elapsed !== null && elapsed < this.minFlightMs) return null;
				this.isContact = true;
				this._lastChange = timestampMs;
				const info = {
					event: "down",
					timestamp: timestampMs,
					flightMs: elapsed
				};
				this.footDown(info);
				return info;
			}
			if (this.isContact && total < this.off) {
				if (elapsed !== null && elapsed < this.minContactMs) return null;
				this.isContact = false;
				this._lastChange = timestampMs;
				const info = {
					event: "up",
					timestamp: timestampMs,
					stanceMs: elapsed
				};
				this.footUp(info);
				return info;
			}
			return null;
		}
	};
	/**
	* device_information.mount_position から装着情報を解釈する。
	* bit0: 0=LEFT, 1=RIGHT / bit1: 0=足底(plantar), 1=足背(dorsal)
	* @returns 数値でない場合（未接続・未取得）は null
	*/
	function sideFromMountPosition(mountPosition) {
		if (typeof mountPosition !== "number" || !Number.isFinite(mountPosition)) return null;
		const isRight = (mountPosition & 1) === 1;
		const isDorsal = (mountPosition & 2) === 2;
		return {
			side: isRight ? "right" : "left",
			surface: isDorsal ? "dorsal" : "plantar",
			isRight,
			isDorsal
		};
	}
	/** 上記ユーティリティをまとめたオブジェクト */
	var OrpheInsoleUtils = {
		SENSOR_COUNT: 6,
		MAX_UINT16,
		SENSOR_LAYOUT_IMAGE,
		SENSOR_LAYOUT,
		mirrorForSide,
		validatePress,
		StuckChannelMonitor,
		PressureCalibrator,
		computeCoP,
		ContactDetector,
		sideFromMountPosition
	};
	//#endregion
	//#region src/session/insole-toolkit-session.ts
	/**
	* InsoleToolkitSession — 1 台の INSOLE（OrpheCoreInsole）に対する通知と FIFO / Gait のライフサイクルを直列化する。
	*
	* 画面を持たない計測セッション管理。InsoleToolkit の設定モーダルもこのセッション経由で操作するため、
	* 独自の記録 UI から使っても通知の所有状態を共有できる。
	* UI からの高速な切替でも sink の二重所有や FIFO drain 中の reset を起こさない。
	*/
	/** リアルタイム配信のヘッダ（FIFO の要求応答パケットは記録しない） */
	var REALTIME_HEADERS = /* @__PURE__ */ new Set([
		50,
		55,
		56
	]);
	/**
	* INSOLE の FW バージョン文字列。アドバタイズ（watchAdvertisements）で受けていればその版、
	* なければ FW 情報のビルド名。どちらも無ければ null。
	*/
	function insoleFirmwareVersion(device) {
		return (device.lastAdvertisement?.status)?.version ?? device.firmware?.name ?? null;
	}
	function isCoreDevice(device) {
		const candidate = device;
		return typeof candidate.onRaw === "function" && !!candidate.transport && "commands" in candidate;
	}
	/** OrpheCoreInsole をセッションの操作形に変換する（互換クラスはそのまま返す） */
	function toSessionDevice(device) {
		if (!isCoreDevice(device)) return device;
		const commands = () => device.commands;
		return {
			get id() {
				return device.id;
			},
			get streaming_mode() {
				return device.profile.streaming_mode ?? void 0;
			},
			begin: (type, options) => device.begin(type, options),
			reset: () => device.reset(),
			isConnected: () => device.isConnected(),
			setDataStreamingMode: (mode) => commands().setDataStreamingMode(mode),
			startNotify: (uuid) => device.transport.startNotify(uuid),
			stopNotify: (uuid) => device.transport.stopNotify(uuid).catch(() => void 0),
			addSensorDataListener: (listener) => device.onRaw((uuid, data) => {
				if (uuid !== "SENSOR_VALUES") return;
				const packet = parseInsoleSensorValues(data, device.profile.sensorParseOptions?.());
				if (!packet || !REALTIME_HEADERS.has(packet.header)) return;
				listener({ packet });
			}),
			getFirmwareVersion: async () => insoleFirmwareVersion(device),
			addAfterReconnectSuccessHook: (hook) => device.transport.addAfterReconnectSuccessHook(hook)
		};
	}
	/**
	* STEP_ANALYSIS 通知が実測で確認できていないファームウェアバージョンの一覧。
	* 該当 FW で Step Analysis を有効化しようとしたときに警告を出す（原因の断定ではなく切り分けの手がかり）。
	*/
	var INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW = Object.freeze(["1.0.1"]);
	function freezeInsoleToolkitProfile(profile) {
		return Object.freeze({
			...profile,
			outputs: Object.freeze({ ...profile.outputs }),
			fields: Object.freeze({ ...profile.fields }),
			recommendedFor: Object.freeze([...profile.recommendedFor || []]),
			cautions: Object.freeze([...profile.cautions || []])
		});
	}
	/**
	* 実機検証済みの計測プロファイル。
	* アプリは低レベル設定を順番に変更せず、applyProfile(id) で原子的に切り替える。
	*/
	var INSOLE_TOOLKIT_PROFILES = Object.freeze({
		"realtime-orientation": freezeInsoleToolkitProfile({
			id: "realtime-orientation",
			label: "Realtime Orientation",
			shortLabel: "Realtime orientation stream",
			streamingMode: 1,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: true,
				stepAnalysis: false
			},
			transport: "notify",
			sampleHz: 200,
			fields: {
				acc: true,
				gyro: true,
				press: false,
				quat: true,
				step: false
			},
			recommendedFor: ["orientation visualization", "low-latency interaction"],
			cautions: ["press is not included", "missed Realtime notifications cannot be retransmitted"]
		}),
		"realtime-pressure": freezeInsoleToolkitProfile({
			id: "realtime-pressure",
			label: "Realtime Pressure + IMU",
			shortLabel: "Realtime pressure and IMU stream",
			streamingMode: 3,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: true,
				stepAnalysis: false
			},
			transport: "notify",
			sampleHz: 200,
			fields: {
				acc: true,
				gyro: true,
				press: true,
				quat: false,
				step: false
			},
			recommendedFor: ["contact and rhythm detection", "high-rate pressure visualization"],
			cautions: ["quat is not included", "missed Realtime notifications cannot be retransmitted"]
		}),
		"realtime-full": freezeInsoleToolkitProfile({
			id: "realtime-full",
			label: "Realtime Full Sensor",
			shortLabel: "Realtime full-sensor stream",
			streamingMode: 4,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: true,
				stepAnalysis: false
			},
			transport: "notify",
			sampleHz: 100,
			fields: {
				acc: true,
				gyro: true,
				press: true,
				quat: true,
				step: false
			},
			recommendedFor: ["full-sensor visualization", "concurrent pressure and orientation"],
			cautions: ["missed Realtime notifications cannot be retransmitted"]
		}),
		"realtime-full-step": freezeInsoleToolkitProfile({
			id: "realtime-full-step",
			label: "Realtime Full + Step Analysis",
			shortLabel: "Concurrent Realtime and STEP_ANALYSIS",
			streamingMode: 4,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: true,
				stepAnalysis: true
			},
			transport: "notify",
			sampleHz: 100,
			fields: {
				acc: true,
				gyro: true,
				press: true,
				quat: true,
				step: true
			},
			recommendedFor: ["live Raw visualization with gait events", "interactive applications"],
			cautions: ["two Notification streams increase BLE load", "Realtime Raw continuity is not guaranteed"]
		}),
		"step-analysis": freezeInsoleToolkitProfile({
			id: "step-analysis",
			label: "Step Analysis",
			shortLabel: "STEP_ANALYSIS Notification only",
			streamingMode: 4,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: false,
				stepAnalysis: true
			},
			transport: "notify",
			sampleHz: null,
			fields: {
				acc: false,
				gyro: false,
				press: false,
				quat: false,
				step: true
			},
			recommendedFor: ["firmware-derived step, stride, and pronation events", "applications that do not require Raw Sensor Values"],
			cautions: ["values are derived by device firmware", "SENSOR_VALUES Notification is disabled"]
		}),
		"fifo-recording": freezeInsoleToolkitProfile({
			id: "fifo-recording",
			label: "FIFO Buffered Recording",
			shortLabel: "Buffered Raw acquisition with continuity checks",
			streamingMode: 4,
			sensorDataMode: "fifo",
			outputs: {
				sensorValues: true,
				stepAnalysis: false
			},
			transport: "request-response",
			sampleHz: 200,
			fields: {
				acc: true,
				gyro: true,
				press: true,
				quat: false,
				step: false
			},
			recommendedFor: ["Raw recording for offline analysis", "acquisition with post-drain continuity validation"],
			cautions: ["Host delivery is bursty and delayed", "quat and STEP_ANALYSIS are unavailable"]
		})
	});
	function insoleToolkitError(code, message) {
		const error = new Error(message);
		error.code = code;
		return error;
	}
	function normalizeInsoleToolkitOutputs(outputs) {
		const normalized = {
			sensorValues: !outputs || outputs.sensorValues !== false,
			stepAnalysis: !!(outputs && outputs.stepAnalysis)
		};
		if (!normalized.sensorValues && !normalized.stepAnalysis) throw insoleToolkitError("NO_DATA_OUTPUT", "InsoleToolkit: select at least one data output.");
		return normalized;
	}
	function normalizeInsoleSensorDataMode(mode) {
		return mode === "fifo" ? "fifo" : "realtime";
	}
	function normalizeInsoleToolkitConfiguration(config = {}, current = {}) {
		const currentOutputs = current.outputs || {
			sensorValues: true,
			stepAnalysis: false
		};
		const outputs = normalizeInsoleToolkitOutputs(config.outputs ? {
			...currentOutputs,
			...config.outputs
		} : currentOutputs);
		const streamingMode = config.streamingMode === void 0 ? Number(current.streamingMode || 4) : Number(config.streamingMode);
		if (![
			1,
			3,
			4
		].includes(streamingMode)) throw insoleToolkitError("INVALID_MODE", `InsoleToolkit: invalid streaming mode ${config.streamingMode}.`);
		if (config.sensorDataMode !== void 0 && config.sensorDataMode !== "realtime" && config.sensorDataMode !== "fifo") throw insoleToolkitError("INVALID_SENSOR_DATA_MODE", `InsoleToolkit: invalid sensor data mode ${config.sensorDataMode}.`);
		const sensorDataMode = config.sensorDataMode === void 0 ? normalizeInsoleSensorDataMode(current.sensorDataMode) : normalizeInsoleSensorDataMode(config.sensorDataMode);
		if (sensorDataMode === "fifo" && !outputs.sensorValues) throw insoleToolkitError("FIFO_REQUIRES_SENSOR_VALUES", "InsoleToolkit: FIFO is a Raw Sensor Data mode. Enable Sensor Values or use Step Analysis with Realtime.");
		if (sensorDataMode === "fifo" && outputs.sensorValues && outputs.stepAnalysis) throw insoleToolkitError("FIFO_STEP_INCOMPATIBLE", "InsoleToolkit: lossless FIFO Raw and Step Analysis cannot run simultaneously on the current firmware. Use sequential modes.");
		return {
			streamingMode,
			sensorDataMode,
			outputs
		};
	}
	function resolveInsoleToolkitProfile(profile) {
		if (typeof profile === "string") {
			const resolved = INSOLE_TOOLKIT_PROFILES[profile];
			if (!resolved) throw insoleToolkitError("PROFILE_NOT_FOUND", `InsoleToolkit: unknown profile "${profile}".`);
			return resolved;
		}
		if (!profile || typeof profile !== "object") throw insoleToolkitError("PROFILE_NOT_FOUND", "InsoleToolkit: profile must be a profile id or configuration object.");
		const config = normalizeInsoleToolkitConfiguration(profile, {
			streamingMode: 4,
			sensorDataMode: "realtime",
			outputs: {
				sensorValues: true,
				stepAnalysis: false
			}
		});
		return {
			id: typeof profile.id === "string" ? profile.id : "custom",
			label: typeof profile.label === "string" ? profile.label : "Custom profile",
			...config
		};
	}
	function insoleToolkitProfileIdFor(config) {
		for (const profile of Object.values(INSOLE_TOOLKIT_PROFILES)) if (profile.streamingMode === config.streamingMode && profile.sensorDataMode === config.sensorDataMode && profile.outputs.sensorValues === config.outputs.sensorValues && profile.outputs.stepAnalysis === config.outputs.stepAnalysis) return profile.id;
		return "custom";
	}
	function insoleToolkitModuleOptions(options, key) {
		const value = options && options[key];
		return value && typeof value === "object" ? value : {};
	}
	function withErrorFields(error, fields) {
		return Object.assign(error, fields);
	}
	var InsoleToolkitSession = class {
		insole;
		options;
		streamingMode;
		sensorDataMode;
		outputs;
		profileId;
		connected = false;
		transitioning = false;
		sensorNotifyActive = false;
		fifoActive = false;
		gaitActive = false;
		measurementPhase = "idle";
		activeMeasurement = null;
		lastMeasurement = null;
		lastError = null;
		/** FIFO 収録モジュール（使えない場合は null） */
		fifo;
		/** Gait（STEP_ANALYSIS）モジュール（使えない場合は null） */
		gait;
		transition = Promise.resolve();
		removeReconnectHook = null;
		measurementSequence = 0;
		sensorDataUnsubscribe = null;
		fifoCallbacks;
		gaitCallbacks;
		verifyGaitNotifications;
		gaitVerifyTimeoutMs;
		gaitVerifyRetries;
		warnedStepUnsupportedFirmware = false;
		stateListeners = /* @__PURE__ */ new Set();
		constructor(insole, options = {}, adapters = {}) {
			this.insole = toSessionDevice(insole);
			this.options = options;
			const initialProfile = options.profile ? resolveInsoleToolkitProfile(options.profile) : null;
			const initialConfig = normalizeInsoleToolkitConfiguration(initialProfile || options, {
				streamingMode: 4,
				sensorDataMode: "realtime",
				outputs: {
					sensorValues: true,
					stepAnalysis: false
				}
			});
			this.streamingMode = initialConfig.streamingMode;
			this.sensorDataMode = initialConfig.sensorDataMode;
			this.outputs = initialConfig.outputs;
			this.profileId = initialProfile?.id || insoleToolkitProfileIdFor(initialConfig);
			const defaults = isCoreDevice(insole) ? {
				FifoClass: FifoRecorder,
				GaitClass: InsoleGait
			} : {};
			const FifoClass = adapters.FifoClass === void 0 ? defaults.FifoClass : adapters.FifoClass;
			const GaitClass = adapters.GaitClass === void 0 ? defaults.GaitClass : adapters.GaitClass;
			const fifoOptions = insoleToolkitModuleOptions(options, "fifo");
			const gaitOptions = insoleToolkitModuleOptions(options, "gait");
			this.fifoCallbacks = fifoOptions;
			this.gaitCallbacks = gaitOptions;
			this.verifyGaitNotifications = gaitOptions.verifyNotifications !== false;
			this.gaitVerifyTimeoutMs = Number.isFinite(Number(gaitOptions.verifyTimeoutMs)) ? Math.max(200, Math.min(1e4, Number(gaitOptions.verifyTimeoutMs))) : 1500;
			this.gaitVerifyRetries = Number.isFinite(Number(gaitOptions.verifyRetries)) ? Math.max(0, Math.min(3, Math.floor(Number(gaitOptions.verifyRetries)))) : 2;
			this.fifo = FifoClass && !options.simulator ? new FifoClass(insole, fifoOptions) : null;
			this.gait = GaitClass && !options.simulator ? new GaitClass(insole, gaitOptions) : null;
			this.wireModuleCallbacks();
		}
		get supportsFifo() {
			return !!this.fifo;
		}
		get supportsStepAnalysis() {
			return !!this.gait;
		}
		snapshot() {
			return {
				connected: this.connected,
				transitioning: this.transitioning,
				profileId: this.profileId,
				profile: INSOLE_TOOLKIT_PROFILES[this.profileId] || null,
				streamingMode: this.streamingMode,
				sensorDataMode: this.sensorDataMode,
				outputs: { ...this.outputs },
				sensorNotifyActive: this.sensorNotifyActive,
				fifoActive: this.fifoActive,
				gaitActive: this.gaitActive,
				measurementPhase: this.measurementPhase,
				measurement: this.activeMeasurement ? this.measurementSnapshot(this.activeMeasurement) : null,
				lastMeasurement: this.lastMeasurement ? this.measurementResultSnapshot(this.lastMeasurement) : null,
				supportsFifo: this.supportsFifo,
				supportsStepAnalysis: this.supportsStepAnalysis,
				gaitDiagnostics: this.gaitDiagnostics(),
				lastError: this.lastError
			};
		}
		/**
		* 状態が変わるたびに呼ばれるリスナーを登録し、解除関数を返す。
		* options.onStateChange と違い、複数登録できる（Toolkit の UI 同期などに使う）。
		*/
		addStateListener(listener) {
			this.stateListeners.add(listener);
			return () => {
				this.stateListeners.delete(listener);
			};
		}
		/** キューに積まれた設定変更・接続操作がすべて終わるまで待つ（失敗しても reject しない） */
		async whenIdle() {
			await this.transition;
		}
		setFifoCallbacks(callbacks = {}) {
			this.fifoCallbacks = callbacks;
		}
		setGaitCallbacks(callbacks = {}) {
			this.gaitCallbacks = callbacks;
		}
		connect(beginOptions = {}) {
			return this.enqueue(async () => {
				this.validateCapabilities(this.configuration());
				if (this.connected && this.insole.isConnected && this.insole.isConnected()) {
					await this.applyDesiredState();
					return "already connected";
				}
				const options = Object.assign({}, this.options, beginOptions, { streamingMode: this.streamingMode });
				delete options.outputs;
				delete options.sensorDataMode;
				delete options.fifo;
				delete options.gait;
				delete options.onStateChange;
				const result = await this.insole.begin("SENSOR_VALUES", options);
				if (!result) return result;
				this.connected = true;
				this.sensorNotifyActive = true;
				try {
					await this.applyDesiredState();
					this.installReconnectHook();
					return result;
				} catch (error) {
					await this.stopFifo();
					await this.stopGait();
					this.uninstallReconnectHook();
					this.insole.reset();
					this.connected = false;
					this.sensorNotifyActive = false;
					throw error;
				}
			});
		}
		disconnect() {
			return this.enqueue(async () => {
				if (this.activeMeasurement) await this.finishMeasurement({
					reason: "disconnect",
					skipRestore: true
				});
				await this.stopFifo();
				await this.stopGait();
				this.removeSensorDataMeasurementListener();
				this.uninstallReconnectHook();
				if (this.insole && typeof this.insole.reset === "function") this.insole.reset();
				this.connected = false;
				this.sensorNotifyActive = false;
				this.fifoActive = false;
				this.gaitActive = false;
			});
		}
		setOutputs(outputs) {
			try {
				const next = normalizeInsoleToolkitOutputs(outputs);
				return this.configure({ outputs: next });
			} catch (error) {
				return this.enqueue(() => {
					throw error;
				});
			}
		}
		setSensorDataMode(mode) {
			return this.configure({ sensorDataMode: normalizeInsoleSensorDataMode(mode) });
		}
		setStreamingMode(mode) {
			return this.configure({ streamingMode: mode });
		}
		/**
		* 複数の低レベル設定を1回の状態遷移として適用する。
		* 個別 setter もこの API へ集約する。
		*/
		configure(config = {}) {
			let next;
			try {
				next = normalizeInsoleToolkitConfiguration(config, this.configuration());
			} catch (error) {
				return this.enqueue(() => {
					throw error;
				});
			}
			return this.enqueue(() => this.applyConfiguration(next, { profileId: insoleToolkitProfileIdFor(next) }));
		}
		/**
		* 実機検証済みの名前付きプロファイル、またはカスタム構成を原子的に適用する。
		*/
		applyProfile(profile) {
			let resolved;
			try {
				resolved = resolveInsoleToolkitProfile(profile);
			} catch (error) {
				return this.enqueue(() => {
					throw error;
				});
			}
			const next = normalizeInsoleToolkitConfiguration(resolved, this.configuration());
			return this.enqueue(() => this.applyConfiguration(next, { profileId: resolved.id }));
		}
		/**
		* 選択したプロファイルの正式計測区間を開始する。
		* Realtime はデコード済み sample、FIFO は checkpoint 以降、Step は完成 row を記録する。
		*/
		startMeasurement(options = {}) {
			return this.enqueue(async () => {
				if (!this.connected) throw insoleToolkitError("NOT_CONNECTED", "InsoleToolkit: connect before starting a measurement.");
				if (this.activeMeasurement) throw insoleToolkitError("MEASUREMENT_ACTIVE", "InsoleToolkit: a measurement is already active.");
				const previousConfiguration = this.configuration();
				const previousProfileId = this.profileId;
				if (options.profile !== void 0) {
					const resolved = resolveInsoleToolkitProfile(options.profile);
					const next = normalizeInsoleToolkitConfiguration(resolved, previousConfiguration);
					await this.applyConfiguration(next, {
						profileId: resolved.id,
						allowDuringMeasurement: true
					});
				}
				const measurement = {
					id: ++this.measurementSequence,
					deviceId: this.insole?.id || 0,
					status: "recording",
					reason: null,
					startedAt: Date.now(),
					endedAt: null,
					durationMs: null,
					profileId: this.profileId,
					profile: INSOLE_TOOLKIT_PROFILES[this.profileId] || {
						id: this.profileId,
						label: "Custom profile",
						...this.configuration()
					},
					previousConfiguration,
					previousProfileId,
					metadata: options.metadata && typeof options.metadata === "object" ? { ...options.metadata } : {},
					limits: {
						maxSamples: Number.isFinite(Number(options.maxSamples)) ? Math.max(0, Number(options.maxSamples)) : 12e4,
						maxStepRows: Number.isFinite(Number(options.maxStepRows)) ? Math.max(0, Number(options.maxStepRows)) : 1e4
					},
					raw: {
						packets: 0,
						samples: [],
						serials: /* @__PURE__ */ new Set(),
						firstSerial: null,
						lastSerial: null,
						lastForwardSerial: null,
						maxSerialDistance: -1,
						truncated: false
					},
					step: {
						packets: 0,
						typeCounts: {
							motion: 0,
							overview: 0,
							stride: 0,
							pronation: 0
						},
						rows: [],
						truncated: false
					},
					fifoCheckpoint: this.sensorDataMode === "fifo" && this.fifo?.createCheckpoint ? this.fifo.createCheckpoint() : null,
					fifoSummary: null,
					restoreProfile: options.restoreProfile
				};
				this.activeMeasurement = measurement;
				this.measurementPhase = "recording";
				this.installSensorDataMeasurementListener();
				this.emitState();
				return this.measurementSnapshot(measurement);
			});
		}
		/**
		* 正式計測を終了する。FIFO は drain 完了を待ってから結果を返す。
		* 多重 click でも直近結果を返すため idempotent。
		*/
		stopMeasurement(options = {}) {
			return this.enqueue(() => this.finishMeasurement({
				reason: options.reason || "manual",
				restoreProfile: options.restoreProfile
			}));
		}
		reapplyAfterReconnect() {
			this.connected = true;
			this.sensorNotifyActive = true;
			this.fifoActive = false;
			this.gaitActive = false;
			return this.enqueue(() => this.applyDesiredState());
		}
		markDisconnected() {
			this.connected = false;
			this.sensorNotifyActive = false;
			this.fifoActive = false;
			if (this.gait && !this.gait.isRunning) this.gaitActive = false;
			this.emitState();
		}
		configuration() {
			return {
				streamingMode: this.streamingMode,
				sensorDataMode: this.sensorDataMode,
				outputs: { ...this.outputs }
			};
		}
		async applyConfiguration(next, options = {}) {
			if (this.activeMeasurement && !options.allowDuringMeasurement) throw insoleToolkitError("MEASUREMENT_ACTIVE", "InsoleToolkit: stop the active measurement before changing profiles.");
			this.validateCapabilities(next);
			const previous = this.configuration();
			const previousProfileId = this.profileId;
			this.streamingMode = next.streamingMode;
			this.sensorDataMode = next.sensorDataMode;
			this.outputs = { ...next.outputs };
			this.profileId = options.profileId || insoleToolkitProfileIdFor(next);
			this.syncOptions();
			try {
				if (this.connected) await this.applyDesiredState();
			} catch (error) {
				if (options.rollbackOnFailure === false) throw error;
				this.streamingMode = previous.streamingMode;
				this.sensorDataMode = previous.sensorDataMode;
				this.outputs = previous.outputs;
				this.profileId = previousProfileId;
				this.syncOptions();
				if (this.connected) try {
					await this.applyDesiredState();
				} catch (rollbackError) {
					this.reportError(rollbackError);
				}
				throw error;
			}
		}
		validateCapabilities(config) {
			if (config.sensorDataMode === "fifo" && config.outputs.sensorValues && !this.supportsFifo) throw insoleToolkitError("FIFO_UNAVAILABLE", "InsoleToolkit: FIFO is not available for this device.");
			if (config.outputs.stepAnalysis && !this.supportsStepAnalysis) throw insoleToolkitError("GAIT_UNAVAILABLE", "InsoleToolkit: Step Analysis is not available for this device.");
		}
		enqueue(operation) {
			const run = async () => {
				this.transitioning = true;
				this.lastError = null;
				this.emitState();
				try {
					return await operation();
				} catch (error) {
					this.lastError = error;
					this.reportError(error);
					throw error;
				} finally {
					this.transitioning = false;
					this.emitState();
				}
			};
			const next = this.transition.then(run, run);
			this.transition = next.catch(() => {});
			return next;
		}
		async applyDesiredState() {
			if (!this.connected) return;
			const desired = this.configuration();
			this.validateCapabilities(desired);
			if (this.sensorDataMode === "fifo") {
				await this.stopGait();
				await this.ensureSensorNotify();
				await this.startFifo();
				return;
			}
			const fifoStopped = await this.stopFifo();
			await this.ensureSensorNotify();
			if (this.insole.streaming_mode !== this.streamingMode) await this.insole.setDataStreamingMode(this.streamingMode);
			if (this.outputs.stepAnalysis) {
				if (fifoStopped && this.gaitActive) await this.refreshGait();
				else await this.startGait();
			} else await this.stopGait();
			if (!this.outputs.sensorValues) await this.stopSensorNotify();
		}
		async ensureSensorNotify() {
			if (this.sensorNotifyActive) return;
			await this.insole.setDataStreamingMode(this.streamingMode);
			await this.insole.startNotify("SENSOR_VALUES");
			this.sensorNotifyActive = true;
		}
		async stopSensorNotify() {
			if (!this.sensorNotifyActive) return;
			await this.insole.stopNotify("SENSOR_VALUES");
			this.sensorNotifyActive = false;
		}
		async startFifo() {
			if (this.fifoActive) return false;
			if (!this.fifo) throw insoleToolkitError("FIFO_UNAVAILABLE", "InsoleToolkit: FIFO is not available for this device.");
			if (!await this.fifo.start()) throw insoleToolkitError("FIFO_START_FAILED", "InsoleToolkit: failed to start FIFO acquisition.");
			this.fifoActive = true;
			return true;
		}
		async stopFifo() {
			if (!this.fifo || !this.fifoActive) return false;
			await this.fifo.stop();
			this.fifoActive = false;
			return true;
		}
		async startGait() {
			if (!this.gait) throw insoleToolkitError("GAIT_UNAVAILABLE", "InsoleToolkit: Step Analysis is not available for this device.");
			await this.warnIfStepAnalysisUnconfirmedFirmware();
			if (this.gaitActive) {
				const beforeDiagnostics = this.gaitDiagnostics();
				try {
					await this.verifyGaitLiveness(beforeDiagnostics, "active");
				} catch (error) {
					try {
						await this.gait.stop();
					} catch {}
					this.gaitActive = false;
					throw error;
				}
				return;
			}
			const beforeDiagnostics = this.gaitDiagnostics();
			if (!await this.gait.start()) throw insoleToolkitError("GAIT_START_FAILED", "InsoleToolkit: failed to start Step Analysis.");
			this.gaitActive = true;
			try {
				await this.verifyGaitLiveness(beforeDiagnostics, "start");
			} catch (error) {
				try {
					await this.gait.stop();
				} catch {}
				this.gaitActive = false;
				throw error;
			}
		}
		async refreshGait() {
			if (!this.gait || !this.gaitActive) return this.startGait();
			if (typeof this.gait.refreshSubscription !== "function") return;
			const beforeDiagnostics = this.gaitDiagnostics();
			const refreshed = await this.gait.refreshSubscription();
			this.gaitActive = !!refreshed;
			if (!refreshed) throw insoleToolkitError("GAIT_REFRESH_FAILED", "InsoleToolkit: failed to refresh Step Analysis after FIFO mode change.");
			try {
				await this.verifyGaitLiveness(beforeDiagnostics, "restore");
			} catch (error) {
				try {
					await this.gait.stop();
				} catch {}
				this.gaitActive = false;
				throw error;
			}
		}
		async stopGait() {
			if (!this.gait || !this.gaitActive) return;
			await this.gait.stop();
			this.gaitActive = false;
		}
		gaitDiagnostics() {
			if (!this.gait || typeof this.gait.diagnostics !== "function") return null;
			try {
				return this.gait.diagnostics();
			} catch {
				return null;
			}
		}
		emitGaitDiagnostic(type, detail = {}) {
			this.callModuleCallback(this.gaitCallbacks, "onDiagnostic", [this.insole?.id || 0, {
				type,
				...detail,
				diagnostics: this.gaitDiagnostics()
			}]);
		}
		/**
		* FW バージョンを解決する（取得できない場合は null。例外は投げない）。
		* getFirmwareVersion() → advertisement 由来の lastStatus.version の順。
		*/
		async resolveFirmwareVersion() {
			try {
				if (this.insole && typeof this.insole.getFirmwareVersion === "function") return await this.insole.getFirmwareVersion();
				if (this.insole && this.insole.lastStatus && this.insole.lastStatus.version) return this.insole.lastStatus.version;
			} catch {}
			return null;
		}
		/**
		* STEP_ANALYSIS 通知が実測で確認できていない既知 FW なら警告を出す（1セッション1回）。
		* ブロックはせず、console.warn と onDiagnostic('fw-step-analysis-unconfirmed') で知らせる。
		*/
		async warnIfStepAnalysisUnconfirmedFirmware() {
			if (this.warnedStepUnsupportedFirmware) return;
			const firmwareVersion = await this.resolveFirmwareVersion();
			if (!firmwareVersion || !INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW.includes(firmwareVersion)) return;
			this.warnedStepUnsupportedFirmware = true;
			console.warn(`InsoleToolkit: firmware ${firmwareVersion} has no confirmed STEP_ANALYSIS output. Step Analysis may stay silent (GAIT_NO_NOTIFICATIONS). Update the device firmware if available.`);
			this.emitGaitDiagnostic("fw-step-analysis-unconfirmed", { firmwareVersion });
		}
		/**
		* startNotifications() の resolve だけで成功扱いにせず、実際の有効 packet 到着を確認する。
		* 無通知時は streaming mode を再適用して STEP_ANALYSIS を再購読する。
		*/
		async verifyGaitLiveness(beforeDiagnostics, context) {
			if (!this.verifyGaitNotifications || !this.gait || typeof this.gait.waitForPacket !== "function") return true;
			const before = beforeDiagnostics;
			const afterValidPackets = Number(before?.validPackets || 0);
			const afterTransportNotifications = Number(before?.transportNotifications || 0);
			const afterInvalidPackets = Number(before?.invalidPackets || 0);
			for (let attempt = 0; attempt <= this.gaitVerifyRetries; attempt++) {
				if (await this.gait.waitForPacket({
					afterCount: afterValidPackets,
					timeoutMs: this.gaitVerifyTimeoutMs
				})) {
					this.emitGaitDiagnostic("liveness-confirmed", {
						context,
						attempt
					});
					return true;
				}
				const diagnostics = this.gaitDiagnostics();
				this.emitGaitDiagnostic("liveness-timeout", {
					context,
					attempt,
					timeoutMs: this.gaitVerifyTimeoutMs
				});
				if (attempt >= this.gaitVerifyRetries) {
					const transportDelta = Math.max(0, Number(diagnostics?.transportNotifications || 0) - afterTransportNotifications);
					const invalidDelta = Math.max(0, Number(diagnostics?.invalidPackets || 0) - afterInvalidPackets);
					const hasTransport = transportDelta > 0;
					const firmwareVersion = await this.resolveFirmwareVersion();
					let message;
					if (hasTransport) message = "InsoleToolkit: STEP_ANALYSIS notifications arrived but no valid packets were decoded.";
					else message = "InsoleToolkit: STEP_ANALYSIS subscription started but no notifications arrived. The device firmware may not support Step Analysis output" + (firmwareVersion ? ` (FW ${firmwareVersion})` : " (firmware version unknown)") + ".";
					throw withErrorFields(new Error(message), {
						code: hasTransport ? "GAIT_INVALID_PACKETS" : "GAIT_NO_NOTIFICATIONS",
						diagnostics,
						transportDelta,
						invalidDelta,
						firmwareVersion
					});
				}
				this.emitGaitDiagnostic("liveness-retry", {
					context,
					attempt: attempt + 1
				});
				if (this.insole && typeof this.insole.setDataStreamingMode === "function") await this.insole.setDataStreamingMode(this.streamingMode);
				if (typeof this.gait.refreshSubscription !== "function") continue;
				const refreshed = await this.gait.refreshSubscription();
				this.gaitActive = !!refreshed;
				if (!refreshed) throw withErrorFields(/* @__PURE__ */ new Error("InsoleToolkit: failed to retry STEP_ANALYSIS notification subscription."), {
					code: "GAIT_REFRESH_FAILED",
					diagnostics: this.gaitDiagnostics()
				});
			}
			return false;
		}
		installSensorDataMeasurementListener() {
			this.removeSensorDataMeasurementListener();
			if (!this.insole || typeof this.insole.addSensorDataListener !== "function") return;
			this.sensorDataUnsubscribe = this.insole.addSensorDataListener((event) => {
				this.captureRealtimePacket(event);
			});
		}
		removeSensorDataMeasurementListener() {
			if (typeof this.sensorDataUnsubscribe === "function") try {
				this.sensorDataUnsubscribe();
			} catch {}
			this.sensorDataUnsubscribe = null;
		}
		captureRealtimePacket(event) {
			const measurement = this.activeMeasurement;
			if (!measurement || measurement.status !== "recording" || this.sensorDataMode !== "realtime") return;
			const packet = event && event.packet;
			if (!packet || !Array.isArray(packet.samples)) return;
			const raw = measurement.raw;
			raw.packets += 1;
			this.recordMeasurementSerial(raw, packet.serial_number);
			this.appendMeasurementSamples(raw, packet.samples);
		}
		captureFifoSamples(samples) {
			const measurement = this.activeMeasurement;
			if (!measurement || !["recording", "draining"].includes(measurement.status) || measurement.profile.sensorDataMode !== "fifo") return;
			if (!Array.isArray(samples)) return;
			const raw = measurement.raw;
			for (const sample of samples) {
				const serial = sample && Number.isInteger(sample.serial_number) ? sample.serial_number : null;
				if (serial !== null) this.recordMeasurementSerial(raw, serial);
			}
			raw.packets = raw.serials.size;
			this.appendMeasurementSamples(raw, samples);
		}
		recordMeasurementSerial(raw, serial) {
			if (!Number.isInteger(serial)) return;
			const normalized = serial & 65535;
			raw.serials.add(normalized);
			if (raw.firstSerial === null || raw.lastForwardSerial === null) {
				raw.firstSerial = normalized;
				raw.lastSerial = normalized;
				raw.lastForwardSerial = normalized;
				raw.maxSerialDistance = 0;
				return;
			}
			const forward = (normalized - raw.lastForwardSerial + 65536) % 65536;
			if (forward === 0) return;
			if (forward >= 32768) {
				const beforeFirst = (raw.firstSerial - normalized + 65536) % 65536;
				if (beforeFirst > 0 && beforeFirst < 32768) {
					raw.firstSerial = normalized;
					raw.maxSerialDistance += beforeFirst;
				}
				return;
			}
			raw.lastForwardSerial = normalized;
			raw.lastSerial = normalized;
			raw.maxSerialDistance = Math.max(raw.maxSerialDistance, (normalized - raw.firstSerial + 65536) % 65536);
		}
		appendMeasurementSamples(raw, samples) {
			const measurement = this.activeMeasurement;
			if (!measurement) return;
			const remaining = Math.max(0, measurement.limits.maxSamples - raw.samples.length);
			if (remaining > 0) raw.samples.push(...samples.slice(0, remaining).map((sample) => this.cloneMeasurementSample(sample)));
			if (samples.length > remaining) raw.truncated = true;
		}
		cloneMeasurementSample(sample) {
			if (!sample || typeof sample !== "object") return sample;
			const copy = { ...sample };
			for (const key of [
				"quat",
				"gyro",
				"acc",
				"converted_gyro",
				"converted_acc",
				"press"
			]) {
				const value = sample[key];
				if (value && typeof value === "object") {
					const cloned = { ...value };
					if (Array.isArray(value.values)) cloned.values = [...value.values];
					copy[key] = cloned;
				}
			}
			return copy;
		}
		captureStepPacket(packet) {
			const measurement = this.activeMeasurement;
			if (!measurement || measurement.status !== "recording" || !this.outputs.stepAnalysis) return;
			measurement.step.packets += 1;
			const type = packet?.type;
			if (typeof type === "string" && Object.prototype.hasOwnProperty.call(measurement.step.typeCounts, type)) measurement.step.typeCounts[type] += 1;
		}
		captureStepRow(row) {
			const measurement = this.activeMeasurement;
			if (!measurement || measurement.status !== "recording" || !this.outputs.stepAnalysis) return;
			if (measurement.step.rows.length < measurement.limits.maxStepRows) measurement.step.rows.push({ ...row });
			else measurement.step.truncated = true;
		}
		async finishMeasurement(options = {}) {
			const measurement = this.activeMeasurement;
			if (!measurement) return this.lastMeasurement;
			measurement.endedAt = Date.now();
			measurement.durationMs = Math.max(0, measurement.endedAt - measurement.startedAt);
			measurement.reason = options.reason || "manual";
			this.removeSensorDataMeasurementListener();
			const wasFifo = measurement.profile.sensorDataMode === "fifo";
			if (wasFifo) {
				measurement.status = "draining";
				this.measurementPhase = "draining";
				this.emitState();
				await this.stopFifo();
				if (measurement.fifoCheckpoint && this.fifo?.summarizeSince) measurement.fifoSummary = this.fifo.summarizeSince(measurement.fifoCheckpoint);
			}
			measurement.status = "completed";
			const result = this.finalizeMeasurementResult(measurement);
			this.lastMeasurement = result;
			let restoreError = null;
			try {
				const restoreProfile = options.restoreProfile ?? measurement.restoreProfile;
				if (!options.skipRestore && wasFifo) {
					const previousWasRealtime = measurement.previousConfiguration.sensorDataMode === "realtime";
					const target = restoreProfile !== false && previousWasRealtime ? measurement.previousConfiguration : INSOLE_TOOLKIT_PROFILES["realtime-full"];
					const targetProfileId = restoreProfile !== false && previousWasRealtime ? measurement.previousProfileId : "realtime-full";
					await this.applyConfiguration(normalizeInsoleToolkitConfiguration(target, this.configuration()), {
						profileId: targetProfileId,
						allowDuringMeasurement: true,
						rollbackOnFailure: false
					});
				} else if (!options.skipRestore && restoreProfile === true) await this.applyConfiguration(measurement.previousConfiguration, {
					profileId: measurement.previousProfileId,
					allowDuringMeasurement: true,
					rollbackOnFailure: false
				});
			} catch (error) {
				restoreError = error;
				if (error && typeof error === "object") Object.defineProperty(error, "measurement", {
					value: result,
					enumerable: false,
					configurable: true
				});
				try {
					await this.applyConfiguration(INSOLE_TOOLKIT_PROFILES["realtime-full"], {
						profileId: "realtime-full",
						allowDuringMeasurement: true,
						rollbackOnFailure: false
					});
				} catch (fallbackError) {
					if (error && typeof error === "object") error.fallbackError = fallbackError;
					this.reportError(fallbackError);
					try {
						await this.stopFifo();
					} catch (stopError) {
						this.reportError(stopError);
					}
					try {
						await this.stopGait();
					} catch (stopError) {
						this.reportError(stopError);
					}
				}
			} finally {
				this.activeMeasurement = null;
				this.measurementPhase = "idle";
				this.emitState();
			}
			if (restoreError) throw restoreError;
			return result;
		}
		measurementSnapshot(measurement) {
			const rawSerial = this.summarizeMeasurementSerial(measurement.raw);
			return {
				id: measurement.id,
				deviceId: measurement.deviceId,
				status: measurement.status,
				reason: measurement.reason,
				startedAt: measurement.startedAt,
				endedAt: measurement.endedAt,
				durationMs: measurement.durationMs,
				profileId: measurement.profileId,
				metadata: { ...measurement.metadata },
				raw: {
					packets: measurement.raw.packets,
					samples: measurement.raw.samples.length,
					serial: rawSerial,
					truncated: measurement.raw.truncated
				},
				step: {
					packets: measurement.step.packets,
					typeCounts: { ...measurement.step.typeCounts },
					rows: measurement.step.rows.length,
					truncated: measurement.step.truncated
				},
				fifo: measurement.fifoSummary ? { ...measurement.fifoSummary } : null
			};
		}
		measurementResultSnapshot(result) {
			return {
				...result,
				raw: {
					...result.raw,
					samples: Array.isArray(result.raw?.samples) ? result.raw.samples.length : Number(result.raw?.samples || 0)
				},
				step: {
					...result.step,
					rows: Array.isArray(result.step?.rows) ? result.step.rows.length : Number(result.step?.rows || 0)
				}
			};
		}
		summarizeMeasurementSerial(raw) {
			if (raw.firstSerial === null || raw.lastSerial === null || raw.maxSerialDistance < 0) return {
				first: null,
				last: null,
				expected: 0,
				received: 0,
				missing: 0,
				missingRate: 0
			};
			const expected = raw.maxSerialDistance + 1;
			let received = 0;
			for (const serial of raw.serials) if ((serial - raw.firstSerial + 65536) % 65536 <= raw.maxSerialDistance) received += 1;
			const missing = Math.max(0, expected - received);
			return {
				first: raw.firstSerial,
				last: raw.lastSerial,
				expected,
				received,
				missing,
				missingRate: expected > 0 ? missing / expected : 0
			};
		}
		finalizeMeasurementResult(measurement) {
			const snapshot = this.measurementSnapshot(measurement);
			const fifoSerial = measurement.fifoSummary?.available ? {
				first: measurement.fifoSummary.first,
				last: measurement.fifoSummary.last,
				expected: measurement.fifoSummary.expected,
				received: measurement.fifoSummary.received,
				missing: measurement.fifoSummary.missing,
				missingRate: measurement.fifoSummary.missingRate
			} : null;
			return {
				...snapshot,
				profile: measurement.profile,
				raw: {
					...snapshot.raw,
					serial: fifoSerial || snapshot.raw.serial,
					samples: measurement.raw.samples.map((sample) => this.cloneMeasurementSample(sample))
				},
				step: {
					...snapshot.step,
					rows: measurement.step.rows.map((row) => ({ ...row }))
				}
			};
		}
		installReconnectHook() {
			if (typeof this.insole?.addAfterReconnectSuccessHook !== "function" || this.removeReconnectHook) return;
			this.removeReconnectHook = this.insole.addAfterReconnectSuccessHook(() => {
				this.reapplyAfterReconnect().catch(() => {});
			});
		}
		uninstallReconnectHook() {
			if (this.removeReconnectHook) this.removeReconnectHook();
			this.removeReconnectHook = null;
		}
		wireModuleCallbacks() {
			if (this.fifo) {
				this.fifo.onSamples = (...args) => {
					this.captureFifoSamples(args[1]);
					this.callModuleCallback(this.fifoCallbacks, "onSamples", args);
				};
				this.fifo.onProgress = (...args) => this.callModuleCallback(this.fifoCallbacks, "onProgress", args);
				this.fifo.onAnomaly = (...args) => this.callModuleCallback(this.fifoCallbacks, "onAnomaly", args);
				this.fifo.onDataLoss = (...args) => this.callModuleCallback(this.fifoCallbacks, "onDataLoss", args);
				this.fifo.onStopped = (info) => {
					this.fifoActive = false;
					this.emitState();
					this.callModuleCallback(this.fifoCallbacks, "onStopped", [info]);
				};
				this.fifo.onError = (error) => {
					this.callModuleCallback(this.fifoCallbacks, "onError", [error]);
					this.reportError(error);
				};
			}
			if (this.gait) {
				this.gait.onGait = (...args) => {
					this.captureStepRow(args[1]);
					this.callModuleCallback(this.gaitCallbacks, "onGait", args);
				};
				this.gait.onMotion = (...args) => this.callModuleCallback(this.gaitCallbacks, "onMotion", args);
				this.gait.onTransport = (...args) => this.callModuleCallback(this.gaitCallbacks, "onTransport", args);
				this.gait.onDiagnostic = (...args) => this.callModuleCallback(this.gaitCallbacks, "onDiagnostic", args);
				this.gait.onStepLoss = (...args) => this.callModuleCallback(this.gaitCallbacks, "onStepLoss", args);
				this.gait.onRaw = (...args) => {
					this.captureStepPacket(args[1]);
					this.callModuleCallback(this.gaitCallbacks, "onRaw", args);
				};
				this.gait.onError = (error) => {
					this.callModuleCallback(this.gaitCallbacks, "onError", [error]);
					this.reportError(error);
				};
			}
		}
		callModuleCallback(callbacks, name, args) {
			const callback = callbacks && callbacks[name];
			if (typeof callback !== "function") return;
			try {
				callback(...args);
			} catch (error) {
				this.reportError(error);
			}
		}
		syncOptions() {
			this.options.streamingMode = this.streamingMode;
			this.options.sensorDataMode = this.sensorDataMode;
			this.options.outputs = { ...this.outputs };
		}
		reportError(error) {
			const callback = this.options && this.options.onError;
			if (typeof callback === "function") try {
				callback(error, this.snapshot());
				return;
			} catch {}
			if (error) console.error("InsoleToolkitSession:", error);
		}
		emitState() {
			this.syncOptions();
			const callback = this.options && this.options.onStateChange;
			if (typeof callback === "function") try {
				callback(this.snapshot());
			} catch (error) {
				this.reportError(error);
			}
			for (const listener of [...this.stateListeners]) try {
				listener(this);
			} catch (error) {
				this.reportError(error);
			}
		}
	};
	function insoleToolkitCsvEscape(value) {
		if (value === void 0 || value === null) return "";
		const text = typeof value === "object" ? JSON.stringify(value) : String(value);
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
	}
	/**
	* startMeasurement() / stopMeasurement() の結果を、その計測区間だけの CSV へ変換する。
	* kind='raw' は Realtime / FIFO で共通列、kind='step' は Step Analysis row を出力する。
	*/
	function insoleToolkitMeasurementToCSV(result, kind = "raw") {
		if (!result || typeof result !== "object") throw insoleToolkitError("INVALID_MEASUREMENT", "InsoleToolkit: a measurement result is required.");
		if (kind !== "raw" && kind !== "step") throw insoleToolkitError("INVALID_CSV_KIND", `InsoleToolkit: CSV kind must be "raw" or "step", received "${kind}".`);
		const rows = kind === "step" ? result.step?.rows : result.raw?.samples;
		if (!Array.isArray(rows)) throw insoleToolkitError("INVALID_MEASUREMENT", `InsoleToolkit: measurement does not contain ${kind === "step" ? "Step" : "Raw"} rows.`);
		if (rows.length === 0) return "";
		if (kind === "raw") {
			const columns = [
				"device_id",
				"profile_id",
				"timestamp",
				"serial_number",
				"packet_number",
				"quat_w",
				"quat_x",
				"quat_y",
				"quat_z",
				"gyro_x",
				"gyro_y",
				"gyro_z",
				"acc_x",
				"acc_y",
				"acc_z",
				"converted_gyro_x",
				"converted_gyro_y",
				"converted_gyro_z",
				"converted_acc_x",
				"converted_acc_y",
				"converted_acc_z",
				"press_0",
				"press_1",
				"press_2",
				"press_3",
				"press_4",
				"press_5"
			];
			const valueFor = (row, column) => {
				if (column === "device_id") return result.deviceId;
				if (column === "profile_id") return result.profileId;
				if (column === "timestamp") return row.timestamp ?? row.t;
				if (column === "serial_number" || column === "packet_number") return row[column];
				const vector = /^(quat|gyro|acc|converted_gyro|converted_acc)_([wxyz])$/.exec(column);
				if (vector) return row[vector[1]]?.[vector[2]];
				const pressure = /^press_(\d)$/.exec(column);
				if (pressure) return row.press?.values?.[Number(pressure[1])];
				return "";
			};
			return [columns.join(","), ...rows.map((row) => columns.map((column) => insoleToolkitCsvEscape(valueFor(row || {}, column))).join(","))].join("\n");
		}
		const preferred = [
			"step_number",
			"gait_type",
			"stride_direction",
			"distance_m",
			"stance_phase_s",
			"swing_phase_s",
			"duration_s",
			"cadence_hz",
			"speed_mps",
			"foot_angle_deg",
			"stride_x_m",
			"stride_y_m",
			"stride_z_m",
			"stride_norm_m",
			"landing_force",
			"strike_angle_deg",
			"foot_strike",
			"pronation_deg",
			"pronation_type",
			"pronation_z_deg",
			"calorie"
		];
		const discovered = /* @__PURE__ */ new Set();
		for (const row of rows) if (row && typeof row === "object") for (const key of Object.keys(row)) discovered.add(key);
		const columns = [
			"device_id",
			"profile_id",
			...preferred.filter((key) => discovered.has(key)),
			...Array.from(discovered).filter((key) => !preferred.includes(key)).sort()
		];
		return [columns.join(","), ...rows.map((row) => columns.map((key) => {
			if (key === "device_id") return insoleToolkitCsvEscape(result.deviceId);
			if (key === "profile_id") return insoleToolkitCsvEscape(result.profileId);
			return insoleToolkitCsvEscape(row?.[key]);
		}).join(","))].join("\n");
	}
	//#endregion
	//#region src/browser.ts
	/**
	* `<script src="orphe-core-insole.js">` で読み込むファイルのエントリ。
	* 公開 API を `OrpheCoreInsoleJS` に置き、互換クラスは同名のグローバルにも置く。
	*/
	var globals = globalThis;
	globals.Orphe = Orphe;
	globals.OrpheInsole = OrpheInsole;
	globals.OrpheInsoleFifo = OrpheInsoleFifo;
	globals.OrpheInsoleGait = OrpheInsoleGait;
	globals.OrpheInsoleSimulator = OrpheInsoleSimulator;
	globals.OrpheInsoleUtils = OrpheInsoleUtils;
	globals.parseInsoleSensorValues = parseInsoleSensorValues;
	globals.ORPHE_INSOLE_STREAMING_MODES = INSOLE_STREAMING_MODES;
	//#endregion
	exports.AutoProfile = AutoProfile;
	exports.BleSharedBridge = BleSharedBridge;
	exports.CORE_ACC_RANGES = CORE_ACC_RANGES;
	exports.CORE_FIFO_MIN_RELEASE_DATE = CORE_FIFO_MIN_RELEASE_DATE;
	exports.CORE_GYRO_RANGES = CORE_GYRO_RANGES;
	exports.CORE_MODES = CORE_MODES;
	exports.CORE_NOTIFICATION_TYPES = CORE_NOTIFICATION_TYPES;
	exports.CoreProfile = CoreProfile;
	exports.DEVICE_INFORMATION_OPCODE = DEVICE_INFORMATION_OPCODE;
	exports.FifoRecorder = FifoRecorder;
	exports.GAIT_TYPES = GAIT_TYPES;
	exports.INSOLE_ACC_RANGES = INSOLE_ACC_RANGES;
	exports.INSOLE_FIFO_MIN_RELEASE_DATE = INSOLE_FIFO_MIN_RELEASE_DATE;
	exports.INSOLE_GYRO_DPS_PER_LSB_PER_RANGE = INSOLE_GYRO_DPS_PER_LSB_PER_RANGE;
	exports.INSOLE_GYRO_RANGES = INSOLE_GYRO_RANGES;
	exports.INSOLE_MODES = INSOLE_MODES;
	exports.INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE = INSOLE_PRESSURE_CALIBRATION_MIN_RELEASE_DATE;
	exports.INSOLE_STREAMING_MODES = INSOLE_STREAMING_MODES;
	exports.INSOLE_TOOLKIT_PROFILES = INSOLE_TOOLKIT_PROFILES;
	exports.INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW = INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW;
	exports.InsoleGait = InsoleGait;
	exports.InsoleProfile = InsoleProfile;
	exports.InsoleToolkitSession = InsoleToolkitSession;
	exports.LegacyDevice = LegacyDevice;
	exports.ORPHE_UUID = ORPHE_UUID;
	exports.Orphe = Orphe;
	exports.OrpheBleTransport = OrpheBleTransport;
	exports.OrpheCoreInsole = OrpheCoreInsole;
	exports.OrpheInsole = OrpheInsole;
	exports.OrpheInsoleFifo = OrpheInsoleFifo;
	exports.OrpheInsoleGait = OrpheInsoleGait;
	exports.OrpheInsoleSimulator = OrpheInsoleSimulator;
	exports.OrpheInsoleUtils = OrpheInsoleUtils;
	exports.STRIDE_DIRECTIONS = STRIDE_DIRECTIONS;
	exports.SampleEmitter = SampleEmitter;
	exports.TransportError = TransportError;
	exports.applyPressureCalibration = applyPressureCalibration;
	exports.attachLegacyCallbacks = attachLegacyCallbacks;
	exports.autoProfile = autoProfile;
	exports.coreCommands = coreCommands;
	exports.coreProfile = coreProfile;
	exports.coreRequestDeviceOptions = coreRequestDeviceOptions;
	exports.createInsoleSimulator = createInsoleSimulator;
	exports.decodeCoreDeviceInformation = decodeCoreDeviceInformation;
	exports.decodeCoreStepAnalysis = decodeCoreStepAnalysis;
	exports.decodeDateTime = decodeDateTime;
	exports.decodeInsoleAdvertisement = decodeInsoleAdvertisement;
	exports.decodeInsoleDeviceInformation = decodeInsoleDeviceInformation;
	exports.defaultBridgeEnvironment = defaultBridgeEnvironment;
	exports.detectDeviceKind = detectDeviceKind;
	exports.downloadCsv = downloadCsv;
	exports.encodeCoreDeviceInformation = encodeCoreDeviceInformation;
	exports.encodeDateTime = encodeDateTime;
	exports.encodeInsoleSensorValues = encodeInsoleSensorValues;
	exports.fieldToGotName = fieldToGotName;
	exports.insoleCommands = insoleCommands;
	exports.insoleFirmwareVersion = insoleFirmwareVersion;
	exports.insoleProfile = insoleProfile;
	exports.insoleRequestDeviceOptions = insoleRequestDeviceOptions;
	exports.insoleSimulatorBluetooth = insoleSimulatorBluetooth;
	exports.insoleStreamingModeOf = insoleStreamingModeOf;
	exports.insoleToolkitMeasurementToCSV = insoleToolkitMeasurementToCSV;
	exports.legacyPressureToNewton = legacyPressureToNewton;
	exports.normalizeInsoleSensorDataMode = normalizeInsoleSensorDataMode;
	exports.normalizeInsoleToolkitConfiguration = normalizeInsoleToolkitConfiguration;
	exports.normalizeInsoleToolkitOutputs = normalizeInsoleToolkitOutputs;
	exports.orpheCharacteristics = orpheCharacteristics;
	exports.parseCoreSensorValues = parseCoreSensorValues;
	exports.parseInsoleSensorValues = parseInsoleSensorValues;
	exports.pressureToN = pressureToN;
	exports.pressureToNewton = pressureToNewton;
	exports.quatToEuler = quatToEuler;
	exports.readDateTime = readDateTime;
	exports.resolveInsoleToolkitProfile = resolveInsoleToolkitProfile;
	exports.serialDistance = serialDistance;
	exports.syncDeviceTime = syncDeviceTime;
	exports.writeDateTime = writeDateTime;
});
