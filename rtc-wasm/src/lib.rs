use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{WebSocket, MessageEvent, CloseEvent};
use js_sys;
use std::cell::RefCell;

// ── Thread-local WebSocket storage (WASM is single-threaded) ──
thread_local! {
    static WS: RefCell<Option<WebSocket>> = RefCell::new(None);
}

// ── Imports: mediasoup bridge (window.mediasoupBridge.*) ──
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "loadDevice")]
    fn ms_load_device(rtp_capabilities: JsValue) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "createSendTransport")]
    fn ms_create_send_transport(params: JsValue) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "createRecvTransport")]
    fn ms_create_recv_transport(params: JsValue) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "handleProducedResponse")]
    fn ms_handle_produced_response(data: JsValue);

    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "requestConsume")]
    fn ms_request_consume(producer_id: JsValue);

    #[wasm_bindgen(js_namespace = mediasoupBridge, js_name = "handleConsumeResponse")]
    fn ms_handle_consume_response(data: JsValue) -> js_sys::Promise;
}

// ── Imports: Angular callbacks (window.__rtcCallbacks.*) ──
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = __rtcCallbacks, js_name = "onConnectionChange")]
    fn on_connection_change(connected: bool);

    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// ── Internal: send JSON through the WebSocket ──
fn send_json(data: &JsValue) {
    WS.with(|ws| {
        if let Some(ref ws) = *ws.borrow() {
            if let Ok(json_str) = js_sys::JSON::stringify(data) {
                let _ = ws.send_with_str(&String::from(json_str));
            }
        }
    });
}

// ── Register send function on window so JS bridge can call it ──
fn register_send_on_window() {
    let send_closure = Closure::wrap(Box::new(|data: JsValue| {
        send_json(&data);
    }) as Box<dyn Fn(JsValue)>);

    let window = web_sys::window().expect("no global window");
    let _ = js_sys::Reflect::set(
        &window,
        &JsValue::from_str("__rtcWasmSend"),
        send_closure.as_ref(),
    );
    send_closure.forget();
}

// ── Handle incoming WebSocket messages ──
fn handle_message(msg: JsValue) {
    spawn_local(async move {
        let action = js_sys::Reflect::get(&msg, &JsValue::from_str("action"))
            .unwrap_or(JsValue::NULL);
        let action_str = action.as_string().unwrap_or_default();
        let payload = js_sys::Reflect::get(&msg, &JsValue::from_str("data"))
            .unwrap_or(JsValue::UNDEFINED);

        log(&format!("📥 WASM received: {}", action_str));

        match action_str.as_str() {
            "rtpCapabilities" => {
                let _ = JsFuture::from(ms_load_device(payload)).await;
            }
            "sendTransportCreated" => {
                let _ = JsFuture::from(ms_create_send_transport(payload)).await;
            }
            "recvTransportCreated" => {
                let _ = JsFuture::from(ms_create_recv_transport(payload)).await;
            }
            "produced" => {
                ms_handle_produced_response(payload);
            }
            "newProducer" => {
                let pid = js_sys::Reflect::get(
                    &payload,
                    &JsValue::from_str("producerId"),
                )
                .unwrap_or(JsValue::NULL);
                ms_request_consume(pid);
            }
            "existingProducers" => {
                if let Some(arr) = payload.dyn_ref::<js_sys::Array>() {
                    for i in 0..arr.length() {
                        let item = arr.get(i);
                        let pid = js_sys::Reflect::get(
                            &item,
                            &JsValue::from_str("producerId"),
                        )
                        .unwrap_or(JsValue::NULL);
                        ms_request_consume(pid);
                    }
                }
            }
            "consumeResponse" => {
                let _ = JsFuture::from(ms_handle_consume_response(payload)).await;
            }
            _ => {
                log(&format!("⚠️ Unknown action: {}", action_str));
            }
        }
    });
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC API — called from Angular
// ══════════════════════════════════════════════════════════════

/// Connect to the signaling server WebSocket.
#[wasm_bindgen]
pub fn connect(url: &str) -> Result<(), JsValue> {
    let ws = WebSocket::new(url)?;

    register_send_on_window();

    // ── onopen ──
    let onopen = Closure::wrap(Box::new(move |_: web_sys::Event| {
        log("🔌 WASM: WebSocket connected");
        on_connection_change(true);
    }) as Box<dyn Fn(web_sys::Event)>);
    ws.set_onopen(Some(onopen.as_ref().unchecked_ref()));
    onopen.forget();

    // ── onclose ──
    let onclose = Closure::wrap(Box::new(move |_: CloseEvent| {
        log("🔌 WASM: WebSocket disconnected");
        on_connection_change(false);
    }) as Box<dyn Fn(CloseEvent)>);
    ws.set_onclose(Some(onclose.as_ref().unchecked_ref()));
    onclose.forget();

    // ── onerror ──
    let onerror = Closure::wrap(Box::new(move |_: web_sys::Event| {
        log("❌ WASM: WebSocket error");
    }) as Box<dyn Fn(web_sys::Event)>);
    ws.set_onerror(Some(onerror.as_ref().unchecked_ref()));
    onerror.forget();

    // ── onmessage ──
    let onmessage = Closure::wrap(Box::new(move |e: MessageEvent| {
        if let Ok(txt) = e.data().dyn_into::<js_sys::JsString>() {
            let json_str: String = txt.into();
            if let Ok(parsed) = js_sys::JSON::parse(&json_str) {
                handle_message(parsed);
            }
        }
    }) as Box<dyn Fn(MessageEvent)>);
    ws.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();

    // Store the WebSocket
    WS.with(|ws_cell| {
        *ws_cell.borrow_mut() = Some(ws);
    });

    Ok(())
}

/// Start the call — asks the server for RTP capabilities.
#[wasm_bindgen]
pub fn start_call() {
    let msg = js_sys::Object::new();
    let _ = js_sys::Reflect::set(
        &msg,
        &JsValue::from_str("action"),
        &JsValue::from_str("getRtpCapabilities"),
    );
    send_json(&msg.into());
}
