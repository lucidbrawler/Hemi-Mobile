(function () {
  try {
    if (window.top !== window.self) return;
  } catch (err) {
    return;
  }
  if (window.ethereum && window.ethereum.isHemi) return;
  var pending = {};
  var listeners = {};
  var seq = 1;
  function emit(event, payload) {
    var list = listeners[event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) {}
    }
  }
  window.__hemiResolve = function (id, ok, payload) {
    var item = pending[id];
    if (!item) return;
    delete pending[id];
    if (ok) item.resolve(payload);
    else {
      var error = new Error((payload && payload.message) || "Request failed");
      error.code = (payload && payload.code) || 4001;
      item.reject(error);
    }
  };
  window.__hemiEmit = function (event, payload) {
    if (event === "accountsChanged") {
      ethereum.selectedAddress = payload && payload.length ? payload[0] : null;
    }
    if (event === "chainChanged" && typeof payload === "string") ethereum.chainId = payload;
    emit(event, payload);
  };
  function ask(method, params) {
    if (!window.HemiDapp || !window.HemiDapp.postMessage) {
      var missing = new Error("This page is not connected to Hemi BTC.");
      missing.code = 4900;
      return Promise.reject(missing);
    }
    var id = seq++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      window.HemiDapp.postMessage(JSON.stringify({
        id: id,
        method: String(method || ""),
        params: params || []
      }));
    });
  }
  var ethereum = {
    isHemi: true,
    isMetaMask: true,
    chainId: "0xa867",
    networkVersion: "43111",
    selectedAddress: null,
    _metamask: {
      isUnlocked: function () { return Promise.resolve(true); }
    },
    request: function (args) {
      return ask(args && args.method, args && args.params);
    },
    send: function (methodOrPayload, params) {
      if (typeof methodOrPayload === "string") return ask(methodOrPayload, params);
      if (methodOrPayload && methodOrPayload.method) return ask(methodOrPayload.method, methodOrPayload.params);
      var bad = new Error("Unsupported request.");
      bad.code = -32601;
      return Promise.reject(bad);
    },
    sendAsync: function (payload, callback) {
      var body = payload || {};
      ask(body.method, body.params).then(function (result) {
        callback(null, { id: body.id, jsonrpc: "2.0", result: result });
      }, function (err) {
        callback(err, { id: body.id, jsonrpc: "2.0", error: { code: err.code || -32603, message: err.message } });
      });
    },
    enable: function () { return ask("eth_requestAccounts", []); },
    on: function (event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
      return ethereum;
    },
    addListener: function (event, fn) { return ethereum.on(event, fn); },
    removeListener: function (event, fn) {
      listeners[event] = (listeners[event] || []).filter(function (item) { return item !== fn; });
      return ethereum;
    },
    removeAllListeners: function (event) {
      delete listeners[event];
      return ethereum;
    }
  };
  window.ethereum = ethereum;
  // app.hemi.xyz only lists an EIP-6963 wallet whose icon starts with "data:image".
  // PNG of the Hemi mark (orange circle, white glyph). SVG data URIs stay blank in this WebView.
  var info = { uuid: "hemi-btc-wallet", name: "Hemi BTC", icon: "data:image/png;base64,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", rdns: "app.demo.hemibtcwallet" };
  function announce() {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: info, provider: ethereum } }));
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  // The page may subscribe after the first announcement. Later ones are ignored if the uuid is already known.
  setTimeout(announce, 50);
  setTimeout(announce, 500);
  try { window.dispatchEvent(new Event("ethereum#initialized")); } catch (err) {}
})();
