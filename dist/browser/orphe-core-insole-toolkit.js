(function(src_index_ts) {
	//#region \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	//#endregion
	//#region src/toolkit/dom.ts
	/** Toolkit の UI 生成に使う共通ヘルパ */
	/** 要素を作って親要素へ追加する */
	function buildElement(tagName, innerHTML, className, style, parent) {
		const element = document.createElement(tagName);
		element.innerHTML = innerHTML;
		element.className = className;
		if (style !== "") element.setAttribute("style", style);
		parent.appendChild(element);
		return element;
	}
	/** id で要素を取る（見つからなければ null） */
	function byId(id) {
		return document.getElementById(id);
	}
	//#endregion
	//#region src/toolkit/device-guard.ts
	/**
	* 別スロットが同じデバイスを使っていれば拒否する DeviceGuard を作る。
	* @param slots スロットの一覧（遅延参照。生成中の配列も扱えるよう関数で渡す）
	* @param id このスロットの番号
	* @param label エラーメッセージに使うデバイス名
	* @param enabled false を返す間は拒否しない
	*/
	function duplicateDeviceGuard(slots, id, label, enabled = () => true) {
		return (device) => {
			if (!enabled()) return null;
			for (const slot of slots()) {
				if (!slot || slot.id === id) continue;
				const assigned = slot.transport.device;
				if (!assigned) continue;
				if (assigned === device || assigned.id && device.id && assigned.id === device.id) return `Bluetooth device "${device.name || device.id || "unknown"}" is already assigned to ${label} ${String(slot.id + 1).padStart(2, "0")}. Select a different device.`;
			}
			return null;
		};
	}
	//#endregion
	//#region src/toolkit/core-toolkit.ts
	/**
	* CoreToolkit — ORPHE CORE の接続 GUI（Bootstrap 5 + bootstrap-icons 前提）。
	*
	* buildCoreToolkit() を呼ぶだけで、接続トグル・周波数・バッテリー・LED・設定モーダルを生成する。
	* 操作対象は cores（= bles）[0] / [1]。要素は OrpheCoreInsole（coreProfile）なので、
	* `cores[0].on('acc', …)` / `cores[0].onEvent('onConnect', …)` / `cores[0].commands.setLED(…)` で使う。
	*/
	var core_toolkit_exports = /* @__PURE__ */ __exportAll({
		CTbuildElement: () => CTbuildElement,
		bles: () => bles,
		buildCoreToolkit: () => buildCoreToolkit,
		changeAccRange: () => changeAccRange,
		changeGryoRange: () => changeGryoRange,
		changeLEDBrightness: () => changeLEDBrightness,
		changeLR: () => changeLR,
		changeNotify: () => changeNotify,
		cores: () => cores,
		guardCoreToolkitBluetooth: () => guardCoreToolkitBluetooth,
		resetCoreModule: () => resetCoreModule,
		setHeaderStatusOffline: () => setHeaderStatusOffline,
		switchCoreBluetoothDevice: () => switchCoreBluetoothDevice,
		toggleCoreModule: () => toggleCoreModule,
		toggleLED: () => toggleLED,
		updateBatteryInfo: () => updateBatteryInfo,
		updateModalParameters: () => updateModalParameters
	});
	/** 別スロットで使用中のデバイスを拒否するか（スロットごと。buildCoreToolkit の rejectDuplicateDevices） */
	var rejectDuplicates = /* @__PURE__ */ new Map();
	function createToolkitCore(id) {
		return new src_index_ts.OrpheCoreInsole({
			profile: (0, src_index_ts.coreProfile)({ namePrefix: "CR-" }),
			id,
			deviceGuard: duplicateDeviceGuard(() => cores, id, "ORPHE CORE", () => rejectDuplicates.get(id) !== false),
			events: { onError: (error) => console.error("CoreToolkit:", error) }
		});
	}
	/** 操作対象の ORPHE CORE（最大 2 台） */
	var cores = [createToolkitCore(0), createToolkitCore(1)];
	/** cores の別名 */
	var bles = cores;
	var toolkitOptions = /* @__PURE__ */ new Map();
	var connecting = /* @__PURE__ */ new Set();
	/** UI 更新用の購読を張ったスロット（二重登録しない） */
	var wiredCores = /* @__PURE__ */ new WeakSet();
	function beginOptionsFor(options) {
		const { range, rejectDuplicateDevices: _reject, tryRememberedBeforePicker: _try, ...rest } = options;
		const beginOptions = {
			...rest,
			useSharedBridge: options.useSharedBridge !== false
		};
		if (range && range.acc !== -1 && range.gyro !== -1) beginOptions.range = range;
		return beginOptions;
	}
	/** 周波数表示の購読をスロットごとに 1 回だけ張る（タブ間共有の Secondary は「共有」表示のまま） */
	function wireToolkitUi(ble) {
		if (wiredCores.has(ble)) return;
		wiredCores.add(ble);
		ble.on("ble_frequency", (freq) => {
			if (ble.sharedBridgeRole === "secondary") return;
			const el = byId(`freq${ble.id}`);
			if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
		});
	}
	function core(no) {
		const target = cores[no];
		if (!target) throw new RangeError(`CoreToolkit: core_id ${no} is out of range.`);
		return target;
	}
	/**
	* コアモジュール操作 GUI を生成する。
	* @param parent_element CoreToolkit を追加する親要素
	* @param title トグルボタンの横に表示するタイトル
	* @param core_id 0 または 1
	* @param notification 開始する通知（STEP_ANALYSIS / SENSOR_VALUES / STEP_ANALYSIS_AND_SENSOR_VALUES）
	*/
	function buildCoreToolkit(parent_element, title, core_id = 0, notification = "STEP_ANALYSIS_AND_SENSOR_VALUES", options = {}) {
		options.range = options.range || {
			acc: -1,
			gyro: -1
		};
		if (typeof options.autoReconnect === "undefined") options.autoReconnect = true;
		toolkitOptions.set(core_id, options);
		if (!(options.range && options.range.acc != -1 && options.range.gyro != -1)) {
			if (options.range.acc == 16) options.range.acc = 3;
			else if (options.range.acc == 8) options.range.acc = 2;
			else if (options.range.acc == 4) options.range.acc = 1;
			else if (options.range.acc == 2) options.range.acc = 0;
			if (options.range.gyro == 2e3) options.range.gyro = 3;
			else if (options.range.gyro == 1e3) options.range.gyro = 2;
			else if (options.range.gyro == 500) options.range.gyro = 1;
			else if (options.range.gyro == 250) options.range.gyro = 0;
		}
		const div_form_check = buildElement("div", "", "form-ckeck form-switch d-flex", "", parent_element);
		div_form_check.id = `core_toolkit${core_id}`;
		const input = buildElement("input", "", "form-check-input position-relative", "", div_form_check);
		input.setAttribute("type", "checkbox");
		input.setAttribute("role", "switch");
		input.setAttribute("id", `switch_ble${core_id}`);
		input.setAttribute("notification", notification);
		input.setAttribute("value", `${core_id}`);
		input.addEventListener("change", function() {
			toggleCoreModule(this, options);
		});
		buildElement("label", title, "form-check-label ms-1", "", div_form_check);
		const span_group = buildElement("span", "", "", "", div_form_check);
		span_group.id = `ui${core_id}`;
		span_group.style.visibility = "hidden";
		const span_activity = buildElement("span", `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq${core_id}">
        </span>
      </i>`, "text-muted ms-1", "", span_group);
		span_activity.id = `icon_bluetooth${core_id}`;
		const span_battery = buildElement("span", `<i class="bi bi-battery"></i>`, "text-muted ms-1", "", span_group);
		span_battery.id = `icon_battery${core_id}`;
		span_battery.setAttribute("core_id", `${core_id}`);
		span_battery.addEventListener("click", function() {
			updateBatteryInfo(span_battery);
		});
		const span_led = buildElement("span", `<i class="bi bi-brightness-alt-high position-relative"><span class="position-absolute  top-0 start-50 tanslate-middle badge text-muted bg-light" style="font-size:0.2em;" id="led_number${core_id}">
          0
        </span>
      </i>`, "text-muted ms-1", "", span_group);
		span_led.id = `icon_led${core_id}`;
		span_led.setAttribute("number", "0");
		span_led.setAttribute("value", `${core_id}`);
		span_led.addEventListener("click", function() {
			toggleLED(span_led);
		});
		const span_settings = buildElement("span", `<i
        class="bi bi-gear"></i>`, "text-muted ms-1", "", span_group);
		span_settings.id = `icon_settings${core_id}`;
		span_settings.setAttribute("value", `${core_id}`);
		span_settings.setAttribute("title", `settings for notification, sensor ranges.`);
		span_settings.setAttribute("data-bs-toggle", "modal");
		span_settings.setAttribute("data-bs-target", `#settings_modal${core_id}`);
		span_settings.addEventListener("click", function() {
			updateModalParameters(core_id);
		});
		const div_modal = buildElement("div", "", "modal fade", "", span_group);
		div_modal.id = `settings_modal${core_id}`;
		div_modal.setAttribute("tanindex", "-1");
		div_modal.setAttribute("aria-labelledby", "exampleModalLabel");
		div_modal.setAttribute("aria-hidden", "true");
		const div_modal_content = buildElement("div", "", "modal-content", "", buildElement("div", "", "modal-dialog text-dark", "", div_modal));
		buildElement("div", `<h5 class="modal-title" id="exampleModalLabel"><i class="bi bi-gear"></i> CORE0${core_id} Settings</h5 >
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, "modal-header", "", div_modal_content);
		const div_modal_body = buildElement("div", `<div class="form-floating mt-2">
    <select class="form-select text-black" id="select_notify${core_id}" aria-label="Floating label select example"
      onchange="changeNotify(${core_id}, this);">
      <option value="STEP_ANALYSIS">STEP_ANALYSIS</option>
      <option value="SENSOR_VALUES">SENSOR_VALUES</option>
      <option value="STEP_ANALYSIS_AND_SENSOR_VALUES" selected>STEP_ANALYSIS_AND_SENSOR_VALUES</option>
    </select>
    <label for="select_notify${core_id}" class="small">Realtime data protocol[not available]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_acc${core_id}" aria-label="Floating label select example"
      onchange="changeAccRange(${core_id},this);">
      <option value="0" selected>2</option>
      <option value="1">4</option>
      <option value="2">8</option>
      <option value="3">16</option>
    </select>
    <label for="select_acc${core_id}" class="small">Accelerometer Range [g]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_gyro${core_id}" aria-label="Floating label select example"
      onchange="changeGryoRange(${core_id},this);">
      <option value="0" selected>250</option>
      <option value="1">500</option>
      <option value="2">1000</option>
      <option value="3">2000</option>
    </select>
    <label for="select_gyro${core_id}" class="small">Gryorscope Range [g]</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_lr${core_id}" aria-label="lr"
    onchange="changeLR(${core_id},this);">
      <option value="0" selected>LEFT instep</option>
      <option value="1">RIGHT instep</option>
      <option value="2">LEFT plantar</option>
      <option value="3">RIGHT plantar</option>
    </select>
    <label for="select_gyro${core_id}" class="small">LEFT/RIGHT</label>
  </div>
  <div class="d-grid gap-2 col-12 mx-auto mt-4">
    <label for="range_brightness${core_id}" class="form-label small">LED Brightness</label>
    <input type="range" class="form-range" min="0" max="255" step="1" id="range_brightness${core_id}" onchange="changeLEDBrightness(${core_id},this);">
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
  <button class="btn btn-warning text-white" type="button" onclick="resetCoreModule(${core_id});">Reset
    Attitude & Gait Analysis</button>
  <button class="btn btn-outline-primary" type="button" id="button_switch_device${core_id}">Select another CORE</button>
	</div>`, "modal-body", "", div_modal_content);
		const select_notify = div_modal_body.querySelector(`#select_notify${core_id}`);
		if (select_notify) {
			if (notification == "STEP_ANALYSIS") select_notify.options[0].selected = true;
			else if (notification == "SENSOR_VALUES") select_notify.options[1].selected = true;
		}
		const switchDeviceButton = div_modal_body.querySelector(`#button_switch_device${core_id}`);
		if (switchDeviceButton) switchDeviceButton.addEventListener("click", function() {
			switchCoreBluetoothDevice(core_id, options);
		});
	}
	/**
	* Web Bluetooth を使えないブラウザ（埋め込みブラウザなど）では接続 UI を無効化し、案内を表示する。
	* @returns Web Bluetooth を利用できる場合は true
	*/
	function guardCoreToolkitBluetooth(options = {}) {
		const coreIds = options.coreIds || [0, 1];
		const message = options.message || "Web Bluetooth is disabled in this browser. Open this page in Chrome to connect ORPHE CORE.";
		const disabledTitle = options.disabledTitle || "Open this page in Chrome to connect ORPHE CORE.";
		const isEmbeddedBrowser = /Electron|Codex/i.test(navigator.userAgent);
		if (window.isSecureContext && !!navigator.bluetooth && !isEmbeddedBrowser) return true;
		coreIds.forEach(function(coreId) {
			const switchBle = byId(`switch_ble${coreId}`);
			if (!switchBle) return;
			switchBle.checked = false;
			switchBle.disabled = true;
			switchBle.title = disabledTitle;
		});
		let messageElement = options.messageElement;
		if (typeof messageElement === "string") messageElement = document.querySelector(messageElement);
		if (messageElement instanceof HTMLElement) {
			if (!messageElement.textContent?.trim()) messageElement.textContent = message;
			messageElement.style.display = "block";
		}
		return false;
	}
	/** 接続トグルが切り替わったときの処理 */
	async function toggleCoreModule(dom, options = {}) {
		const checked = dom.checked;
		const number = parseInt(dom.value);
		const ble = core(number);
		const notification = dom.getAttribute("notification") || "STEP_ANALYSIS_AND_SENSOR_VALUES";
		if (connecting.has(number)) {
			dom.checked = ble.isConnected();
			return;
		}
		if (checked) {
			const connectOptions = beginOptionsFor(options);
			const hasRemotePrimary = connectOptions.useSharedBridge === true && new src_index_ts.BleSharedBridge(number).isRemotePrimaryAvailable();
			const hasRememberedDevice = !!ble.transport.rememberedDevice();
			const shouldTryRememberedFirst = !!options.forceDeviceSelection && options.tryRememberedBeforePicker === true && (hasRemotePrimary || hasRememberedDevice);
			const firstBeginOptions = shouldTryRememberedFirst ? {
				...connectOptions,
				forceDeviceSelection: false
			} : connectOptions;
			rejectDuplicates.set(number, options.rejectDuplicateDevices !== false);
			wireToolkitUi(ble);
			connecting.add(number);
			dom.disabled = true;
			try {
				try {
					await ble.begin(notification, firstBeginOptions);
				} catch (error) {
					if (!shouldTryRememberedFirst || !hasRememberedDevice || hasRemotePrimary) throw error;
					ble.transport.forgetRememberedDevice();
					await ble.begin(notification, connectOptions);
				}
			} catch (error) {
				const sw = byId(`switch_ble${number}`);
				if (sw) sw.checked = false;
				const ui = byId(`ui${number}`);
				if (ui) ui.style.visibility = "hidden";
				ble.reportError(error);
				return;
			} finally {
				connecting.delete(number);
				dom.disabled = false;
			}
			const ui = byId(`ui${number}`);
			if (ui) ui.style.visibility = "visible";
			if (ble.sharedBridgeRole === "secondary") {
				const freqEl = byId(`icon_bluetooth${number}`);
				if (freqEl) {
					freqEl.innerHTML = `<i class="bi bi-broadcast position-relative">
                  <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;" id="freq${number}">
                    共有
                  </span>
                </i>`;
					freqEl.title = "別タブのBLE接続を共有中";
				}
				const off = ble.onEvent("onDisconnect", () => {
					off();
					const sw = byId(`switch_ble${number}`);
					if (sw) sw.checked = false;
					const uiEl = byId(`ui${number}`);
					if (uiEl) uiEl.style.visibility = "hidden";
				});
			}
		} else {
			ble.reset();
			const ui = byId(`ui${number}`);
			if (ui) ui.style.visibility = "hidden";
		}
	}
	/** 別の Bluetooth デバイスを chooser で選び直して接続する */
	async function switchCoreBluetoothDevice(no, options = {}) {
		const ble = core(no);
		const sw = byId(`switch_ble${no}`);
		const uiEl = byId(`ui${no}`);
		const notification = sw?.getAttribute("notification") || "STEP_ANALYSIS_AND_SENSOR_VALUES";
		rejectDuplicates.set(no, options.rejectDuplicateDevices !== false);
		wireToolkitUi(ble);
		try {
			if (uiEl) uiEl.style.visibility = "hidden";
			ble.releaseSharedBridge();
			await ble.transport.selectDevice();
			const ret = await ble.begin(notification, beginOptionsFor(options));
			if (sw) sw.checked = !!ret;
			if (ret && uiEl) uiEl.style.visibility = "visible";
		} catch (error) {
			if (sw) sw.checked = false;
			if (uiEl) uiEl.style.visibility = "hidden";
			ble.reportError(error);
		}
	}
	/**
	* 接続したまま通知の種類を切り替える。
	* 同じ通知を二重に登録しないよう、登録済みの通知を止めてから begin し直す。
	*/
	function changeNotify(no, dom) {
		const ble = core(no);
		const options = beginOptionsFor(toolkitOptions.get(no) || {});
		const restart = () => {
			setTimeout(function() {
				ble.begin(dom.value, options).catch((error) => ble.reportError(error));
			}, 500);
		};
		const stop = (uuid) => ble.transport.stopNotify(uuid).catch(() => void 0);
		const current = ble.lastBeginType;
		if (current == "STEP_ANALYSIS") stop("STEP_ANALYSIS").then(restart);
		else if (current == "SENSOR_VALUES") stop("SENSOR_VALUES").then(restart);
		else if (current == "STEP_ANALYSIS_AND_SENSOR_VALUES") stop("STEP_ANALYSIS").then(() => stop("SENSOR_VALUES")).then(restart);
	}
	/** 加速度センサのレンジを変更する（select の値は index 0..3） */
	async function changeAccRange(no, dom) {
		const commands = core(no).commands;
		await commands.readDeviceInformation();
		await commands.setRange({ acc: src_index_ts.CORE_ACC_RANGES[parseInt(dom.value)] });
	}
	/** ジャイロセンサのレンジを変更する（select の値は index 0..3） */
	async function changeGryoRange(no, dom) {
		const commands = core(no).commands;
		await commands.readDeviceInformation();
		await commands.setRange({ gyro: src_index_ts.CORE_GYRO_RANGES[parseInt(dom.value)] });
	}
	/** LED の明るさを変更する */
	async function changeLEDBrightness(no, dom) {
		const commands = core(no).commands;
		await commands.readDeviceInformation();
		await commands.setLEDBrightness(parseInt(dom.value));
	}
	/** 取り付け位置（左右・足背/足底）を変更する */
	async function changeLR(no, dom) {
		await core(no).commands.setMountPosition(parseInt(dom.value));
	}
	/** 設定モーダルの表示をデバイスの現在値に合わせる */
	async function updateModalParameters(no) {
		const obj = await core(no).commands.readDeviceInformation();
		const accOption = byId(`select_acc${no}`)?.options[obj.range.acc];
		if (accOption) accOption.selected = true;
		const gyroOption = byId(`select_gyro${no}`)?.options[obj.range.gyro];
		if (gyroOption) gyroOption.selected = true;
		const brightness = byId(`range_brightness${no}`);
		if (brightness) brightness.value = String(obj.led_brightness);
		const lrOption = byId(`select_lr${no}`)?.options[obj.lr];
		if (lrOption) lrOption.selected = true;
	}
	/** 姿勢と歩行解析をリセットする */
	function resetCoreModule(id) {
		const target = core(id);
		target.commands.resetAttitude().catch((error) => target.reportError(error));
		target.commands.resetAnalysisLogs().catch((error) => target.reportError(error));
	}
	/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
	async function updateBatteryInfo(dom) {
		const number = parseInt(dom.getAttribute("core_id") || "0");
		const obj = await core(number).commands.readDeviceInformation();
		let str_battery_status;
		if (obj.battery == 0) str_battery_status = "empty";
		else if (obj.battery == 1) str_battery_status = "normal";
		else if (obj.battery == 2) str_battery_status = "full";
		const icon = byId(`icon_battery${number}`);
		if (!icon) return;
		icon.setAttribute("title", `${str_battery_status} `);
		if (obj.battery == 0) {
			icon.innerHTML = "<i class=\"bi bi-battery\"></i>";
			icon.className = "text-warning";
		} else if (obj.battery == 1) icon.innerHTML = "<i class=\"bi bi-battery-half\"></i>";
		else if (obj.battery == 2) icon.innerHTML = "<i class=\"bi bi-battery-full\"></i>";
	}
	/** LED の発光パターンを 1〜6 → 消灯 の順に切り替える */
	function toggleLED(dom) {
		let number = parseInt(dom.getAttribute("number") || "0");
		const id = parseInt(dom.getAttribute("value") || "0");
		number++;
		if (number > 6) number = 0;
		const label = byId(`led_number${id}`);
		if (label) label.innerText = String(number);
		const target = core(id);
		target.commands.setLED(number !== 0, number).catch((error) => target.reportError(error));
		dom.setAttribute("number", String(number));
	}
	/** 接続トグルをオフ表示にする */
	function setHeaderStatusOffline(id) {
		const sw = byId(`switch_ble${id}`);
		if (sw) sw.checked = false;
	}
	/** buildElement の別名 */
	var CTbuildElement = buildElement;
	//#endregion
	//#region src/toolkit/insole-toolkit.ts
	/**
	* InsoleToolkit — ORPHE INSOLE の接続 GUI（Bootstrap 5 + bootstrap-icons 前提）。
	*
	* buildInsoleToolkit() を呼ぶだけで、接続トグル・周波数・左右バッジ・バッテリー・FW バージョン・
	* 再接続ステータス・設定モーダル（出力選択 / Realtime・FIFO / ストリーミング形式）を生成する。
	* 計測の状態管理は InsoleToolkitSession が持ち、getInsoleToolkitSession() で取り出せる。
	* 操作対象は insoles[0] / [1]。要素は OrpheCoreInsole（insoleProfile）なので、
	* `insoles[0].on('press', …)` / `insoles[0].onEvent('onConnect', …)` / `insoles[0].commands` で使う。
	*/
	var insole_toolkit_exports = /* @__PURE__ */ __exportAll({
		ITbuildElement: () => ITbuildElement,
		buildInsoleToolkit: () => buildInsoleToolkit,
		changeInsoleDataOutputs: () => changeInsoleDataOutputs,
		changeInsoleSensorDataMode: () => changeInsoleSensorDataMode,
		changeInsoleStreamingMode: () => changeInsoleStreamingMode,
		getInsoleToolkitSession: () => getInsoleToolkitSession,
		insoleToolkitSessions: () => insoleToolkitSessions,
		insoles: () => insoles,
		installInsoleToolkitCallbacks: () => installInsoleToolkitCallbacks,
		isInsoleToolkitUserCancel: () => isInsoleToolkitUserCancel,
		resetInsoleModule: () => resetInsoleModule,
		setInsoleHeaderStatusOffline: () => setInsoleHeaderStatusOffline,
		syncInsoleToolkitControls: () => syncInsoleToolkitControls,
		toggleInsoleModule: () => toggleInsoleModule,
		updateInsoleBatteryInfo: () => updateInsoleBatteryInfo,
		updateInsoleFirmwareBadge: () => updateInsoleFirmwareBadge,
		updateInsoleLRBadge: () => updateInsoleLRBadge,
		updateInsoleModalParameters: () => updateInsoleModalParameters
	});
	/** シミュレータに差し替えたスロット */
	var simulatedSlots = /* @__PURE__ */ new Set();
	function createToolkitInsole(id) {
		return new src_index_ts.OrpheCoreInsole({
			profile: (0, src_index_ts.insoleProfile)(),
			id,
			deviceGuard: duplicateDeviceGuard(() => insoles, id, "ORPHE INSOLE"),
			events: { onError: (error) => console.error("InsoleToolkit:", error) }
		});
	}
	/** 操作対象の ORPHE INSOLE（最大 2 足） */
	var insoles = [createToolkitInsole(0), createToolkitInsole(1)];
	/** buildInsoleToolkit() が生成したデバイス別セッション */
	var insoleToolkitSessions = [null, null];
	var MODE_NOTE = "Realtime Raw and Step Analysis can run together. FIFO is lossless Raw recording and runs alone.";
	var sessionsByInsole = /* @__PURE__ */ new WeakMap();
	var callbacksInstalled = /* @__PURE__ */ new WeakSet();
	function insole(no) {
		const target = insoles[no];
		if (!target) throw new RangeError(`InsoleToolkit: insole_id ${no} is out of range.`);
		return target;
	}
	/**
	* インソール操作 GUI を生成する。
	* @param parent_element InsoleToolkit を追加する親要素
	* @param title トグルボタンの横に表示するタイトル
	* @param insole_id 0 または 1
	* @param options sensorDataMode / outputs / profile / fifo / gait / simulator と begin() のオプション。
	*   fifo: false / gait: false でその機能を設定画面から選べなくする。
	*   simulator: true で実機の代わりに createInsoleSimulator() の擬似 INSOLE を使う。
	*/
	function buildInsoleToolkit(parent_element, title, insole_id = 0, options = {}) {
		if (options.profile !== void 0) {
			const initialProfile = (0, src_index_ts.resolveInsoleToolkitProfile)(options.profile);
			options.streamingMode = initialProfile.streamingMode;
			options.sensorDataMode = initialProfile.sensorDataMode;
			options.outputs = { ...initialProfile.outputs };
		}
		if (typeof options.streamingMode === "undefined") options.streamingMode = 4;
		if (typeof options.autoReconnect === "undefined") options.autoReconnect = true;
		if (typeof options.sensorDataMode === "undefined") options.sensorDataMode = "realtime";
		if (typeof options.outputs === "undefined") options.outputs = {
			sensorValues: true,
			stepAnalysis: false
		};
		if (options.simulator === true && !simulatedSlots.has(insole_id)) {
			insoles[insole_id] = (0, src_index_ts.createInsoleSimulator)(insole_id, {}, { events: { onError: (error) => console.error("InsoleToolkit:", error) } });
			simulatedSlots.add(insole_id);
		}
		const adapters = {
			FifoClass: options.fifo === false ? null : src_index_ts.FifoRecorder,
			GaitClass: options.gait === false ? null : src_index_ts.InsoleGait
		};
		const session = new src_index_ts.InsoleToolkitSession(insole(insole_id), options, adapters);
		session.addStateListener(() => syncInsoleToolkitControls(insole_id));
		insoleToolkitSessions[insole_id] = session;
		sessionsByInsole.set(insole(insole_id), session);
		const div_form_check = buildElement("div", "", "form-check form-switch d-flex", "", parent_element);
		div_form_check.id = `insole_toolkit${insole_id}`;
		const input = buildElement("input", "", "form-check-input position-relative", "", div_form_check);
		input.setAttribute("type", "checkbox");
		input.setAttribute("role", "switch");
		input.setAttribute("id", `switch_ble${insole_id}`);
		input.setAttribute("value", `${insole_id}`);
		input.setAttribute("aria-label", `Connect ${title}`);
		input.addEventListener("change", function() {
			toggleInsoleModule(this, options);
		});
		buildElement("label", title, "form-check-label ms-1", "", div_form_check);
		const span_group = buildElement("span", "", "", "", div_form_check);
		span_group.id = `ui${insole_id}`;
		span_group.style.visibility = "hidden";
		const span_activity = buildElement("span", `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq${insole_id}">
        </span>
      </i>`, "text-muted ms-1", "", span_group);
		span_activity.id = `icon_bluetooth${insole_id}`;
		const span_lr = buildElement("span", `<span class="badge bg-secondary" id="lr_badge${insole_id}">-</span>`, "ms-1", "", span_group);
		span_lr.id = `icon_lr${insole_id}`;
		span_lr.setAttribute("title", "mount position (L/R)");
		const span_battery = buildElement("span", `<i class="bi bi-battery"></i>`, "text-muted ms-1", "", span_group);
		span_battery.id = `icon_battery${insole_id}`;
		span_battery.setAttribute("insole_id", `${insole_id}`);
		span_battery.addEventListener("click", function() {
			updateInsoleBatteryInfo(span_battery);
		});
		const span_fw = buildElement("span", `<span class="badge bg-light text-secondary border" id="fw_badge${insole_id}"></span>`, "ms-1", "", span_group);
		span_fw.id = `icon_fw${insole_id}`;
		span_fw.style.display = "none";
		span_fw.setAttribute("title", "firmware version");
		const span_reconnect = buildElement("span", `<i class="bi bi-arrow-repeat"></i><span class="small" id="reconnect_text${insole_id}"></span>`, "text-warning ms-1", "", span_group);
		span_reconnect.id = `icon_reconnect${insole_id}`;
		span_reconnect.style.display = "none";
		span_reconnect.setAttribute("title", "auto reconnecting...");
		const span_settings = buildElement("span", `<i class="bi bi-gear"></i>`, "text-muted ms-1", "", span_group);
		span_settings.id = `icon_settings${insole_id}`;
		span_settings.setAttribute("value", `${insole_id}`);
		span_settings.setAttribute("title", `settings for streaming mode.`);
		span_settings.setAttribute("data-bs-toggle", "modal");
		span_settings.setAttribute("data-bs-target", `#settings_modal${insole_id}`);
		span_settings.addEventListener("click", function() {
			updateInsoleModalParameters(insole_id);
		});
		const existingModal = byId(`settings_modal${insole_id}`);
		if (existingModal) existingModal.remove();
		const div_modal = buildElement("div", "", "modal fade", "", document.body);
		div_modal.id = `settings_modal${insole_id}`;
		div_modal.setAttribute("tabindex", "-1");
		div_modal.setAttribute("aria-hidden", "true");
		const div_modal_content = buildElement("div", "", "modal-content", "", buildElement("div", "", "modal-dialog text-dark", "", div_modal));
		buildElement("div", `<h5 class="modal-title"><i class="bi bi-gear"></i> INSOLE0${insole_id} Settings</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, "modal-header", "", div_modal_content);
		buildElement("div", `<fieldset class="border rounded p-2 mt-2">
    <legend class="float-none w-auto px-1 mb-1 small">Data Outputs</legend>
    <div class="form-check form-check-inline mb-0">
      <input class="form-check-input" type="checkbox" id="output_sensor_values${insole_id}">
      <label class="form-check-label small" for="output_sensor_values${insole_id}">Raw Sensor Data</label>
    </div>
    <div class="form-check form-check-inline mb-0">
      <input class="form-check-input" type="checkbox" id="output_step_analysis${insole_id}">
      <label class="form-check-label small" for="output_step_analysis${insole_id}">Step Analysis</label>
    </div>
  </fieldset>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_sensor_data_mode${insole_id}">
      <option value="realtime">Realtime</option>
      <option value="fifo">FIFO (gyro + acc + press, no quat)</option>
    </select>
    <label for="select_sensor_data_mode${insole_id}" class="small">Raw Data Acquisition</label>
  </div>
  <div class="form-floating mt-2">
    <select class="form-select text-black" id="select_streaming_mode${insole_id}"
      onchange="changeInsoleStreamingMode(${insole_id}, this);">
      <option value="1">1: quat + gyro + acc (200Hz)</option>
      <option value="3">3: gyro + acc + press (200Hz)</option>
      <option value="4" selected>4: gyro + acc + press + quat (100Hz)</option>
    </select>
    <label for="select_streaming_mode${insole_id}" class="small">Realtime Streaming Format</label>
  </div>
  <div id="toolkit_mode_status${insole_id}" class="small text-muted mt-2" role="status"></div>
  <div id="toolkit_mode_note${insole_id}" class="small text-muted mt-1">
    ${MODE_NOTE}
  </div>
  <div class="row mt-3 small text-muted">
    <div class="col-6">Accelerometer Range: <span id="info_acc_range${insole_id}">-</span> g</div>
    <div class="col-6">Gyroscope Range: <span id="info_gyro_range${insole_id}">-</span> °/s</div>
  </div>
  <div class="row mt-1 small text-muted">
    <div class="col-12">Mount Position: <span id="info_mount_position${insole_id}">-</span></div>
  </div>
  <div class="row mt-1 small text-muted">
    <div class="col-12">Firmware: <span id="info_firmware${insole_id}">-</span></div>
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
    <button class="btn btn-warning text-white" type="button" onclick="resetInsoleModule(${insole_id});">Reset
      Analysis Logs</button>
  </div>`, "modal-body", "", div_modal_content);
		const select_mode = div_modal_content.querySelector(`#select_streaming_mode${insole_id}`);
		for (const opt of Array.from(select_mode.options)) opt.selected = parseInt(opt.value) === options.streamingMode;
		const select_sensor_data_mode = div_modal_content.querySelector(`#select_sensor_data_mode${insole_id}`);
		select_sensor_data_mode.value = session.sensorDataMode;
		const output_sensor_values = div_modal_content.querySelector(`#output_sensor_values${insole_id}`);
		const output_step_analysis = div_modal_content.querySelector(`#output_step_analysis${insole_id}`);
		output_sensor_values.checked = session.outputs.sensorValues;
		output_step_analysis.checked = session.outputs.stepAnalysis;
		output_sensor_values.addEventListener("change", () => {
			changeInsoleDataOutputs(insole_id);
		});
		output_step_analysis.addEventListener("change", () => {
			changeInsoleDataOutputs(insole_id);
		});
		select_sensor_data_mode.addEventListener("change", function() {
			changeInsoleSensorDataMode(insole_id, this);
		});
		syncInsoleToolkitControls(insole_id);
	}
	/** 接続トグルが切り替わったときの処理 */
	async function toggleInsoleModule(dom, options = {}) {
		const checked = dom.checked;
		const number = parseInt(dom.value);
		const target = insole(number);
		const session = getInsoleToolkitSession(number);
		if (!session) return;
		dom.disabled = true;
		if (checked) {
			let ret;
			try {
				ret = await session.connect({
					...options,
					forceDeviceSelection: true
				});
			} catch (error) {
				if (!isInsoleToolkitUserCancel(error)) console.error("toggleInsoleModule connect failed:", error);
				ret = null;
			}
			if (!ret) {
				const sw = byId(`switch_ble${number}`);
				if (sw) sw.checked = false;
				dom.disabled = false;
				syncInsoleToolkitControls(number);
				return;
			}
			const ui = byId(`ui${number}`);
			if (ui) ui.style.visibility = "visible";
			updateInsoleLRBadge(number);
			updateInsoleFirmwareBadge(number);
			installInsoleToolkitCallbacks(target, session);
		} else try {
			await session.disconnect();
		} catch (error) {
			console.error("toggleInsoleModule disconnect failed:", error);
		} finally {
			const ui = byId(`ui${number}`);
			if (ui) ui.style.visibility = "hidden";
		}
		dom.disabled = false;
		syncInsoleToolkitControls(number);
	}
	/** Toolkit の表示更新をデバイスのイベントへ購読する（1 デバイス 1 回。利用者の購読とは独立） */
	function installInsoleToolkitCallbacks(target, session) {
		sessionsByInsole.set(target, session);
		if (callbacksInstalled.has(target)) return;
		callbacksInstalled.add(target);
		const id = target.id;
		target.on("ble_frequency", (freq) => {
			const el = byId(`freq${id}`);
			if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
		});
		target.onEvent("onDisconnect", () => {
			sessionsByInsole.get(target)?.markDisconnected();
		});
		target.onEvent("onReconnectAttempt", (info) => {
			const icon = byId(`icon_reconnect${id}`);
			const text = byId(`reconnect_text${id}`);
			if (icon) icon.style.display = "";
			if (text) text.innerText = `${info.attempt}/${info.maxAttempts}`;
		});
		target.onEvent("onReconnectSuccess", () => {
			const icon = byId(`icon_reconnect${id}`);
			if (icon) icon.style.display = "none";
			updateInsoleLRBadge(id);
			updateInsoleFirmwareBadge(id);
		});
		target.onEvent("onReconnectFailed", () => {
			const icon = byId(`icon_reconnect${id}`);
			if (icon) icon.style.display = "none";
			sessionsByInsole.get(target)?.markDisconnected();
			setInsoleHeaderStatusOffline(id);
			const ui = byId(`ui${id}`);
			if (ui) ui.style.visibility = "hidden";
		});
	}
	/** chooser のキャンセルかどうか */
	function isInsoleToolkitUserCancel(error) {
		const message = error && error.message ? error.message : String(error || "");
		return Boolean(error && error.name === "NotFoundError") || /cancelled|canceled|chooser/i.test(message);
	}
	/** device_information.mount_position（bit0: 0=LEFT, 1=RIGHT）から左右バッジを更新する */
	function updateInsoleLRBadge(no) {
		const badge = byId(`lr_badge${no}`);
		if (!badge) return;
		const info = insole(no).profile.device_information;
		if (!info || typeof info.mount_position === "undefined") {
			badge.innerText = "-";
			return;
		}
		const isRight = (info.mount_position & 1) === 1;
		badge.innerText = isRight ? "R" : "L";
		badge.classList.remove("bg-secondary");
		badge.classList.add(isRight ? "bg-primary" : "bg-success");
	}
	/**
	* FW バージョンバッジを更新する。取得できない FW・環境では非表示のまま。
	* Step Analysis 未確認の既知 FW は警告色で表示する。
	*/
	async function updateInsoleFirmwareBadge(no) {
		const badge = byId(`fw_badge${no}`);
		const wrap = byId(`icon_fw${no}`);
		if (!badge || !wrap) return;
		const version = (0, src_index_ts.insoleFirmwareVersion)(insole(no));
		if (!version) {
			badge.innerText = "";
			wrap.style.display = "none";
			return;
		}
		badge.innerText = `FW ${version}`;
		wrap.style.display = "";
		if (src_index_ts.INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW.includes(version)) {
			badge.classList.remove("bg-light", "text-secondary");
			badge.classList.add("bg-warning", "text-dark");
			wrap.setAttribute("title", `firmware ${version}: Step Analysis通知が確認できていないFWです（FW更新を検討してください）`);
		} else {
			badge.classList.remove("bg-warning", "text-dark");
			badge.classList.add("bg-light", "text-secondary");
			wrap.setAttribute("title", "firmware version");
		}
	}
	/**
	* buildInsoleToolkit() が生成したデバイス別セッションを返す。
	* 独自の記録 UI もこのセッション経由で操作すると、設定モーダルと通知の所有状態を共有できる。
	*/
	function getInsoleToolkitSession(no) {
		return insoleToolkitSessions[no] || null;
	}
	/** 設定モーダルの出力選択（Raw / Step Analysis）が変わったときの処理 */
	async function changeInsoleDataOutputs(no) {
		const session = getInsoleToolkitSession(no);
		if (!session) return;
		const sensorValues = byId(`output_sensor_values${no}`);
		const stepAnalysis = byId(`output_step_analysis${no}`);
		try {
			await session.setOutputs({
				sensorValues: !!(sensorValues && sensorValues.checked),
				stepAnalysis: !!(stepAnalysis && stepAnalysis.checked)
			});
		} catch (error) {
			if (error && error.code !== "NO_DATA_OUTPUT") console.error("changeInsoleDataOutputs failed:", error);
		} finally {
			syncInsoleToolkitControls(no);
		}
	}
	/** 設定モーダルの取得経路（Realtime / FIFO）が変わったときの処理 */
	async function changeInsoleSensorDataMode(no, dom) {
		const session = getInsoleToolkitSession(no);
		if (!session) return;
		try {
			await session.setSensorDataMode(dom.value);
		} catch (error) {
			console.error("changeInsoleSensorDataMode failed:", error);
		} finally {
			syncInsoleToolkitControls(no);
		}
	}
	/** 設定モーダルのストリーミング形式が変わったときの処理 */
	async function changeInsoleStreamingMode(no, dom) {
		const mode = parseInt(dom.value);
		const session = getInsoleToolkitSession(no);
		if (!session) return;
		try {
			await session.setStreamingMode(mode);
		} catch (error) {
			console.error("changeInsoleStreamingMode failed:", error);
		} finally {
			syncInsoleToolkitControls(no);
		}
	}
	/** 設定モーダルの各コントロールをセッションの状態に合わせる */
	function syncInsoleToolkitControls(no) {
		const session = getInsoleToolkitSession(no);
		if (!session || typeof document === "undefined") return;
		const state = session.snapshot();
		const sensorValues = byId(`output_sensor_values${no}`);
		const stepAnalysis = byId(`output_step_analysis${no}`);
		const sensorDataMode = byId(`select_sensor_data_mode${no}`);
		const streamingMode = byId(`select_streaming_mode${no}`);
		const status = byId(`toolkit_mode_status${no}`);
		const note = byId(`toolkit_mode_note${no}`);
		if (sensorValues) {
			if (!state.transitioning) sensorValues.checked = state.outputs.sensorValues;
			sensorValues.disabled = state.transitioning || state.measurementPhase !== "idle";
		}
		if (stepAnalysis) {
			if (!state.transitioning) stepAnalysis.checked = state.outputs.stepAnalysis;
			const fifoSelected = state.outputs.sensorValues && state.sensorDataMode === "fifo";
			stepAnalysis.disabled = state.transitioning || state.measurementPhase !== "idle" || !state.supportsStepAnalysis || fifoSelected;
			stepAnalysis.title = !state.supportsStepAnalysis ? "Step Analysis is not available for this device." : fifoSelected ? "Step Analysis is available with Realtime Raw, not FIFO." : "";
		}
		if (sensorDataMode) {
			if (!state.transitioning) sensorDataMode.value = state.sensorDataMode;
			sensorDataMode.disabled = state.transitioning || state.measurementPhase !== "idle" || !state.outputs.sensorValues;
			const fifoOption = Array.from(sensorDataMode.options).find((option) => option.value === "fifo");
			if (fifoOption) {
				fifoOption.disabled = !state.supportsFifo || state.outputs.stepAnalysis;
				fifoOption.title = state.outputs.stepAnalysis ? "Turn off Step Analysis before selecting FIFO." : "";
			}
		}
		if (streamingMode) {
			if (!state.transitioning) streamingMode.value = String(state.streamingMode);
			streamingMode.disabled = state.transitioning || state.measurementPhase !== "idle" || !state.outputs.sensorValues || state.sensorDataMode === "fifo";
		}
		if (status) {
			status.classList.toggle("text-danger", !!state.lastError);
			status.classList.toggle("text-muted", !state.lastError);
			if (state.measurementPhase === "draining") status.innerText = "Recording stopped. Recovering the remaining FIFO samples…";
			else if (state.measurementPhase === "recording") status.innerText = `Recording: ${state.profile?.label || state.profileId}`;
			else if (state.transitioning) status.innerText = "Switching data mode…";
			else if (state.lastError) status.innerText = state.lastError.message || String(state.lastError);
			else if (!state.connected) status.innerText = "Changes apply on the next connection.";
			else if (!state.outputs.sensorValues) status.innerText = "Active: Step Analysis only";
			else if (state.sensorDataMode === "fifo" && !state.fifoActive) status.innerText = "FIFO stopped. Select Realtime, then FIFO, to restart.";
			else status.innerText = `Active: ${state.sensorDataMode === "fifo" ? "FIFO Raw Data" : "Realtime Raw Data"}${state.outputs.stepAnalysis ? " + Step Analysis" : ""}`;
		}
		if (note) {
			const unavailable = [];
			if (!state.supportsFifo) unavailable.push("FIFO is not available.");
			if (!state.supportsStepAnalysis) unavailable.push("Step Analysis is not available.");
			note.innerText = unavailable.length ? unavailable.join(" ") : MODE_NOTE;
		}
	}
	/** 設定モーダルのレンジ・取り付け位置・FW 表示を更新する */
	async function updateInsoleModalParameters(no) {
		const obj = await insole(no).commands.readDeviceInformation();
		const ACC_RANGE = {
			0: 2,
			1: 4,
			2: 8,
			3: 16
		};
		const GYRO_RANGE = {
			0: 250,
			1: 500,
			2: 1e3,
			3: 2e3
		};
		const acc_el = byId(`info_acc_range${no}`);
		const gyro_el = byId(`info_gyro_range${no}`);
		const mount_el = byId(`info_mount_position${no}`);
		if (acc_el) acc_el.innerText = String(ACC_RANGE[obj.range.acc] ?? obj.range.acc);
		if (gyro_el) gyro_el.innerText = String(GYRO_RANGE[obj.range.gyro] ?? obj.range.gyro);
		if (mount_el) {
			const isRight = (obj.mount_position & 1) === 1;
			const isInstep = (obj.mount_position & 2) === 2;
			mount_el.innerText = `${isRight ? "RIGHT" : "LEFT"} / ${isInstep ? "instep(足背)" : "plantar(足底)"}`;
		}
		const fw_el = byId(`info_firmware${no}`);
		if (fw_el) fw_el.innerText = (0, src_index_ts.insoleFirmwareVersion)(insole(no)) || "unknown";
		syncInsoleToolkitControls(no);
		updateInsoleLRBadge(no);
		updateInsoleFirmwareBadge(no);
	}
	/** インソールの解析ログをリセットする */
	function resetInsoleModule(id) {
		const target = insole(id);
		target.commands.resetAnalysisLogs().catch((error) => target.reportError(error));
	}
	/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
	async function updateInsoleBatteryInfo(dom) {
		const number = parseInt(dom.getAttribute("insole_id") || "0");
		const obj = await insole(number).commands.readDeviceInformation();
		let str_battery_status;
		if (obj.battery == 0) str_battery_status = "empty";
		else if (obj.battery == 1) str_battery_status = "normal";
		else if (obj.battery == 2) str_battery_status = "full";
		const el = byId(`icon_battery${number}`);
		if (!el) return;
		el.setAttribute("title", `${str_battery_status}`);
		if (obj.battery == 0) {
			el.innerHTML = "<i class=\"bi bi-battery\"></i>";
			el.classList.add("text-warning");
		} else if (obj.battery == 1) el.innerHTML = "<i class=\"bi bi-battery-half\"></i>";
		else if (obj.battery == 2) el.innerHTML = "<i class=\"bi bi-battery-full\"></i>";
	}
	/** 接続トグルをオフ表示にする */
	function setInsoleHeaderStatusOffline(id) {
		const el = byId(`switch_ble${id}`);
		if (el) el.checked = false;
	}
	/** buildElement の別名 */
	var ITbuildElement = buildElement;
	//#endregion
	//#region src/toolkit/core-companion-toolkit.ts
	/**
	* CoreCompanionToolkit — INSOLE のページに ORPHE CORE を 1 台だけ同居させる接続 GUI。
	*
	* 生成する CORE は orpheCore（insoles / cores とは独立したインスタンス）。
	* chooser は名前（既定 'CR-'）とサービス UUID のどちらでも CORE を拾い、
	* header 50 の 104 バイト版パケットも受け付ける。
	* orpheCore は OrpheCoreInsole（coreProfile）なので、`orpheCore.on('converted_acc', …)` で使う。
	*/
	var core_companion_toolkit_exports = /* @__PURE__ */ __exportAll({
		CCTbuildElement: () => CCTbuildElement,
		buildCoreCompanionToolkit: () => buildCoreCompanionToolkit,
		changeCoreCompanionNotification: () => changeCoreCompanionNotification,
		coreCompanionPromiseWithTimeout: () => coreCompanionPromiseWithTimeout,
		isOrpheCoreSdkLoaded: () => isOrpheCoreSdkLoaded,
		orpheCore: () => orpheCore,
		resetCoreCompanionAnalysisLogs: () => resetCoreCompanionAnalysisLogs,
		resetCoreCompanionAttitude: () => resetCoreCompanionAttitude,
		setCoreCompanionStatusOffline: () => setCoreCompanionStatusOffline,
		setOrpheCore: () => setOrpheCore$1,
		toggleCoreCompanion: () => toggleCoreCompanion,
		toggleCoreCompanionLED: () => toggleCoreCompanionLED,
		updateCoreCompanionBatteryInfo: () => updateCoreCompanionBatteryInfo,
		updateCoreCompanionModalParameters: () => updateCoreCompanionModalParameters
	});
	/** buildCoreCompanionToolkit() が生成した ORPHE CORE（未生成なら null） */
	var orpheCore = null;
	var companionOptions = {};
	var ledOn = false;
	/** CORE の SDK が使える状態か */
	function isOrpheCoreSdkLoaded() {
		return typeof src_index_ts.OrpheCoreInsole === "function";
	}
	/**
	* ORPHE CORE 1 台分の接続 GUI を生成する。
	* @returns 生成した ORPHE CORE インスタンス（orpheCore と同一）
	*/
	function buildCoreCompanionToolkit(parent_element, title, options = {}) {
		if (typeof options.notification === "undefined") options.notification = "STEP_ANALYSIS_AND_SENSOR_VALUES";
		if (typeof options.range === "undefined") options.range = {
			acc: 16,
			gyro: 2e3
		};
		if (typeof options.autoReconnect === "undefined") options.autoReconnect = false;
		if (typeof options.connectTimeoutMs === "undefined") options.connectTimeoutMs = 2e4;
		if (typeof options.chooserNamePrefix === "undefined") options.chooserNamePrefix = "CR-";
		if (!orpheCore) {
			orpheCore = new src_index_ts.OrpheCoreInsole({
				profile: (0, src_index_ts.coreProfile)({
					namePrefix: options.chooserNamePrefix,
					acceptExtendedSensorValues: true
				}),
				id: 0,
				events: { onError: (error) => console.error("CoreCompanionToolkit:", error) }
			});
			wireCompanionUi(orpheCore);
		} else orpheCore.profile.setNamePrefix(options.chooserNamePrefix);
		companionOptions = options;
		const div_form_check = buildElement("div", "", "form-check form-switch d-flex", "", parent_element);
		div_form_check.id = "core_toolkit0";
		const input = buildElement("input", "", "form-check-input position-relative", "", div_form_check);
		input.setAttribute("type", "checkbox");
		input.setAttribute("role", "switch");
		input.setAttribute("id", "switch_core0");
		input.addEventListener("change", function() {
			toggleCoreCompanion(this);
		});
		buildElement("label", title, "form-check-label ms-1", "", div_form_check);
		const span_group = buildElement("span", "", "", "", div_form_check);
		span_group.id = "ui_core0";
		span_group.style.visibility = "hidden";
		const span_activity = buildElement("span", `<i class="bi bi-activity position-relative">
        <span class="position-absolute top-0 start-50 translate-middle badge text-muted" style="font-size:0.2em;"
          id="freq_core0">
        </span>
      </i>`, "text-muted ms-1", "", span_group);
		span_activity.id = "icon_bluetooth_core0";
		const span_battery = buildElement("span", `<i class="bi bi-battery"></i>`, "text-muted ms-1", "", span_group);
		span_battery.id = "icon_battery_core0";
		span_battery.addEventListener("click", function() {
			updateCoreCompanionBatteryInfo();
		});
		const span_led = buildElement("span", `<i class="bi bi-lightbulb"></i>`, "text-muted ms-1", "", span_group);
		span_led.id = "icon_led_core0";
		span_led.setAttribute("title", "toggle LED");
		span_led.addEventListener("click", function() {
			toggleCoreCompanionLED();
		});
		const span_settings = buildElement("span", `<i class="bi bi-gear"></i>`, "text-muted ms-1", "", span_group);
		span_settings.id = "icon_settings_core0";
		span_settings.setAttribute("title", "settings for ORPHE CORE");
		span_settings.setAttribute("data-bs-toggle", "modal");
		span_settings.setAttribute("data-bs-target", "#settings_modal_core0");
		span_settings.addEventListener("click", function() {
			updateCoreCompanionModalParameters();
		});
		const div_modal = buildElement("div", "", "modal fade", "", span_group);
		div_modal.id = "settings_modal_core0";
		div_modal.setAttribute("tabindex", "-1");
		div_modal.setAttribute("aria-hidden", "true");
		const div_modal_content = buildElement("div", "", "modal-content", "", buildElement("div", "", "modal-dialog text-dark", "", div_modal));
		buildElement("div", `<h5 class="modal-title"><i class="bi bi-gear"></i> ORPHE CORE Settings</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>`, "modal-header", "", div_modal_content);
		buildElement("div", `<div class="form-floating mt-2">
    <select class="form-select text-black" id="select_core_notification0"
      onchange="changeCoreCompanionNotification(this);">
      <option value="STEP_ANALYSIS">STEP_ANALYSIS (gait/stride, ~30Hz)</option>
      <option value="SENSOR_VALUES">SENSOR_VALUES (acc/gyro/quat, 50-200Hz)</option>
      <option value="STEP_ANALYSIS_AND_SENSOR_VALUES">STEP_ANALYSIS + SENSOR_VALUES</option>
    </select>
    <label for="select_core_notification0" class="small">Notification Type (次回接続時に反映)</label>
  </div>
  <div class="row mt-3 small text-muted">
    <div class="col-6">Accelerometer Range: <span id="info_core_acc_range0">-</span> g</div>
    <div class="col-6">Gyroscope Range: <span id="info_core_gyro_range0">-</span> °/s</div>
  </div>
  <div class="d-grid gap-2 col-10 mx-auto mt-4">
    <button class="btn btn-secondary" type="button" onclick="resetCoreCompanionAttitude();">Reset Attitude</button>
    <button class="btn btn-warning text-white" type="button" onclick="resetCoreCompanionAnalysisLogs();">Reset
      Analysis Logs</button>
  </div>`, "modal-body", "", div_modal_content);
		const select_notify = div_modal_content.querySelector("#select_core_notification0");
		if (select_notify) for (const opt of Array.from(select_notify.options)) opt.selected = opt.value === options.notification;
		return orpheCore;
	}
	/** 接続トグルが切り替わったときの処理 */
	async function toggleCoreCompanion(dom) {
		const core = orpheCore;
		if (!core) return;
		const options = companionOptions;
		if (dom.checked) {
			let ret = null;
			try {
				ret = await coreCompanionPromiseWithTimeout(core.begin(options.notification, {
					range: options.range,
					autoReconnect: options.autoReconnect,
					forceDeviceSelection: true
				}), options.connectTimeoutMs);
			} catch (error) {
				if (!isCoreCompanionUserCancel(error)) console.error("toggleCoreCompanion connect failed:", error);
				ret = null;
			}
			if (!ret) {
				const sw = byId("switch_core0");
				if (sw) sw.checked = false;
				return;
			}
			const ui = byId("ui_core0");
			if (ui) ui.style.visibility = "visible";
			wireCompanionUi(core);
		} else {
			core.reset();
			const ui = byId("ui_core0");
			if (ui) ui.style.visibility = "hidden";
		}
	}
	var wiredCompanions = /* @__PURE__ */ new WeakSet();
	/** 周波数表示と切断時の UI 戻しを購読する（インスタンスごとに 1 回。利用者の購読とは独立） */
	function wireCompanionUi(core) {
		if (wiredCompanions.has(core)) return;
		wiredCompanions.add(core);
		core.on("ble_frequency", (freq) => {
			const el = byId("freq_core0");
			if (el) el.innerHTML = `${Math.floor(freq)} Hz`;
		});
		core.onEvent("onDisconnect", () => setCoreCompanionStatusOffline());
	}
	/** timeoutMs 経過で null に解決する begin() 用のガード（0 以下なら待つだけ） */
	function coreCompanionPromiseWithTimeout(promise, timeoutMs) {
		if (!timeoutMs || timeoutMs <= 0) return promise;
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				console.warn(`CoreCompanionToolkit: begin() が ${timeoutMs}ms 以内に完了しませんでした。接続失敗として扱います。`);
				resolve(null);
			}, timeoutMs);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}
	function isCoreCompanionUserCancel(error) {
		const message = error && error.message ? error.message : String(error || "");
		return Boolean(error && error.name === "NotFoundError") || /cancelled|canceled|chooser|User cancel/i.test(message);
	}
	/** 通知の種類を変える（接続中の通知は切り替えず、次回接続時に反映する） */
	function changeCoreCompanionNotification(dom) {
		if (!orpheCore) return;
		companionOptions.notification = dom.value;
	}
	/** 設定モーダルのレンジ表示を更新する */
	async function updateCoreCompanionModalParameters() {
		if (!orpheCore) return;
		try {
			const obj = await orpheCore.commands.readDeviceInformation();
			const ACC_RANGE = {
				0: 2,
				1: 4,
				2: 8,
				3: 16
			};
			const GYRO_RANGE = {
				0: 250,
				1: 500,
				2: 1e3,
				3: 2e3
			};
			const acc_el = byId("info_core_acc_range0");
			const gyro_el = byId("info_core_gyro_range0");
			if (acc_el) acc_el.innerText = String(ACC_RANGE[obj.range.acc] ?? obj.range.acc);
			if (gyro_el) gyro_el.innerText = String(GYRO_RANGE[obj.range.gyro] ?? obj.range.gyro);
		} catch (error) {
			console.error("updateCoreCompanionModalParameters failed:", error);
		}
	}
	/** バッテリー残量（3 段階）に合わせてアイコンを更新する */
	async function updateCoreCompanionBatteryInfo() {
		if (!orpheCore) return;
		try {
			const obj = await orpheCore.commands.readDeviceInformation();
			let str_battery_status;
			if (obj.battery == 0) str_battery_status = "empty";
			else if (obj.battery == 1) str_battery_status = "normal";
			else if (obj.battery == 2) str_battery_status = "full";
			const el = byId("icon_battery_core0");
			if (!el) return;
			el.setAttribute("title", `${str_battery_status}`);
			if (obj.battery == 0) {
				el.innerHTML = "<i class=\"bi bi-battery\"></i>";
				el.classList.add("text-warning");
			} else if (obj.battery == 1) el.innerHTML = "<i class=\"bi bi-battery-half\"></i>";
			else if (obj.battery == 2) el.innerHTML = "<i class=\"bi bi-battery-full\"></i>";
		} catch (error) {
			console.error("updateCoreCompanionBatteryInfo failed:", error);
		}
	}
	/** LED のオン・オフを切り替える（pattern 0 固定） */
	function toggleCoreCompanionLED() {
		if (!orpheCore) return;
		ledOn = !ledOn;
		const core = orpheCore;
		core.commands.setLED(ledOn, 0).catch((error) => core.reportError(error));
		const el = byId("icon_led_core0");
		if (el) el.innerHTML = ledOn ? "<i class=\"bi bi-lightbulb-fill\"></i>" : "<i class=\"bi bi-lightbulb\"></i>";
	}
	/** 姿勢（quaternion）の基準をリセットする */
	function resetCoreCompanionAttitude() {
		if (!orpheCore) return;
		const core = orpheCore;
		core.commands.resetAttitude().catch((error) => core.reportError(error));
	}
	/** CORE の解析ログをリセットする */
	function resetCoreCompanionAnalysisLogs() {
		if (!orpheCore) return;
		const core = orpheCore;
		core.commands.resetAnalysisLogs().catch((error) => core.reportError(error));
	}
	/** トグルをオフにして UI を隠す */
	function setCoreCompanionStatusOffline() {
		const sw = byId("switch_core0");
		if (sw) sw.checked = false;
		const ui = byId("ui_core0");
		if (ui) ui.style.visibility = "hidden";
	}
	/** テスト用: 生成済みの orpheCore を差し替える */
	function setOrpheCore$1(core) {
		orpheCore = core;
		if (core) wireCompanionUi(core);
		ledOn = false;
	}
	/** buildElement の別名 */
	var CCTbuildElement = buildElement;
	//#endregion
	//#region src/toolkit/entry.ts
	/**
	* `<script src="orphe-core-insole-toolkit.js">` で読み込むファイルのエントリ。
	* 先に orphe-core-insole.js を読み込んでおくこと。buildCoreToolkit() などをグローバルに置く
	* （設定モーダルの onchange 属性からも呼ばれる）。
	*/
	var globals = globalThis;
	var { orpheCore: _orpheCore, setOrpheCore, ...companion } = core_companion_toolkit_exports;
	Object.assign(globals, core_toolkit_exports, insole_toolkit_exports, companion, {
		InsoleToolkitSession: src_index_ts.InsoleToolkitSession,
		INSOLE_TOOLKIT_PROFILES: src_index_ts.INSOLE_TOOLKIT_PROFILES,
		INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW: src_index_ts.INSOLE_TOOLKIT_STEP_UNSUPPORTED_FW,
		resolveInsoleToolkitProfile: src_index_ts.resolveInsoleToolkitProfile,
		normalizeInsoleToolkitConfiguration: src_index_ts.normalizeInsoleToolkitConfiguration,
		normalizeInsoleToolkitOutputs: src_index_ts.normalizeInsoleToolkitOutputs,
		normalizeInsoleSensorDataMode: src_index_ts.normalizeInsoleSensorDataMode,
		insoleToolkitMeasurementToCSV: src_index_ts.insoleToolkitMeasurementToCSV
	});
	Object.defineProperty(globalThis, "orpheCore", {
		configurable: true,
		get: () => orpheCore,
		set: (core) => setOrpheCore(core)
	});
	//#endregion
})(OrpheCoreInsoleJS);
