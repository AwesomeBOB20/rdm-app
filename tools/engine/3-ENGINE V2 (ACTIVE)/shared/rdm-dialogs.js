/* ============================================================================
   RDM shared dialogs — one styled panel for every prompt/confirm/alert across
   all three tools. Reuses the shared .modal chrome (backdrop, stack, panel,
   head, close, open/close animations) from rdm-theme.css, so every dialog
   matches the pickers by construction. Replaces native window.prompt/confirm/
   alert (which look nothing like the app).

   Each function takes the tool's `root` (a ShadowRoot when embedded, or
   `document` standalone) so the overlay lands in the right tree, and an options
   object. Returns a Promise. Theme is a class string: "theme-orange" /
   "theme-purple" / "theme-teal" (matches the tool's panels).

     RDMDialogs.name(root, {title, value, placeholder, theme}) -> Promise<string|null>
     RDMDialogs.confirm(root, {title, message, confirmLabel, theme}) -> Promise<boolean>
     RDMDialogs.alert(root, {title, message, theme}) -> Promise<void>

   confirm() has a second, richer mode for the freemium upsell prompts (Anthony, 2026-07-31): pass
   `bullets` (an array of specific things the purchase unlocks) and it renders a wider "locked feature"
   card instead of the plain one-line confirm — a locked badge, a bold hook line, a checked value list,
   an optional price line, and a CTA button with a soft attention pulse. Every OTHER confirm() call in the
   app (delete/rename confirmations) has no bullets and renders exactly as before — this is additive, not
   a redesign of the base dialog. See Playalongs/Sightreading Lab/Metronome's own `upsell()` helper for
   the one place each tool builds these opts.
   ============================================================================ */
(function () {
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  // the ONE padlock shape used everywhere in the app (tabs, tiles, meters) — see [[app-lock-icon]].
  var LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';

  function build(root, theme, rich) {
    var overlay = el("div", "modal modal--dialog " + (rich ? "modal--rich " : "") + (theme || "") + " is-open");
    var stack = el("div", "modal__stack");
    overlay.appendChild(stack);
    return { overlay: overlay, stack: stack, host: root.body || root };
  }

  function addHead(stack, title) {
    var h = el("div", "modal__panel modal__head");
    var h3 = el("h3"); h3.textContent = title || ""; h3.style.flex = "1";
    var x = el("button", "modal__close"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.textContent = "×";
    h.appendChild(h3); h.appendChild(x); stack.appendChild(h);
    return x;
  }

  function makeClose(overlay, resolve) {
    var done = false;
    return function (val) {
      if (done) return; done = true;
      overlay.classList.add("is-closing"); overlay.classList.remove("is-open");
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(val); }, 170);
    };
  }

  function btn(cls, label) { var b = el("button", "namebox__btn " + cls); b.type = "button"; b.textContent = label; return b; }
  function actions() { return el("div", "namebox__actions"); }

  function name(root, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var b = build(root, opts.theme);
      var x = addHead(b.stack, opts.title || "Name");
      var body = el("div", "modal__panel modal__body");
      var input = el("input", "modal__search"); input.type = "text"; input.setAttribute("autocomplete", "off");
      input.value = opts.value || ""; input.placeholder = opts.placeholder || "";
      var act = actions();
      var cancel = btn("namebox__btn--cancel", "Cancel");
      var save = btn("namebox__btn--save", "Save");
      act.appendChild(cancel); act.appendChild(save);
      body.appendChild(input); body.appendChild(act); b.stack.appendChild(body);
      var close = makeClose(b.overlay, resolve);
      x.addEventListener("click", function () { close(null); });
      cancel.addEventListener("click", function () { close(null); });
      save.addEventListener("click", function () { close(input.value.trim()); });
      b.overlay.addEventListener("mousedown", function (e) { if (e.target === b.overlay) close(null); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); close(input.value.trim()); }
        else if (e.key === "Escape") { e.preventDefault(); close(null); }
      });
      b.host.appendChild(b.overlay);
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) {} }, 30);
    });
  }

  function confirmDialog(root, opts) {
    opts = opts || {};
    var rich = !!(opts.bullets && opts.bullets.length);
    return new Promise(function (resolve) {
      var b = build(root, opts.theme, rich);
      var x = addHead(b.stack, opts.title || "Are you sure?");
      var body = el("div", "modal__panel modal__body" + (rich ? " modal__body--rich" : ""));
      if (rich) {
        var chip = el("div", "modal__lockchip");
        var ic = el("span", "modal__lockic"); ic.innerHTML = LOCK_SVG; chip.appendChild(ic);
        var chipTxt = document.createElement("span"); chipTxt.textContent = "Locked feature";
        chip.appendChild(chipTxt);
        body.appendChild(chip);
      }
      if (opts.message) {
        var p = el("p", rich ? "modal__hook" : null);
        p.textContent = opts.message;
        body.appendChild(p);
      }
      if (rich) {
        var ul = el("ul", "modal__benefits");
        opts.bullets.forEach(function (line) {
          var li = document.createElement("li");
          li.textContent = line;
          ul.appendChild(li);
        });
        body.appendChild(ul);
        if (opts.price) {
          var price = el("p", "modal__price");
          price.textContent = opts.price;
          body.appendChild(price);
        }
      }
      var act = actions();
      var cancel = btn("namebox__btn--cancel", opts.cancelLabel || "Cancel");
      var ok = btn("namebox__btn--save" + (rich ? " namebox__btn--glow" : ""), opts.confirmLabel || "Delete");
      act.appendChild(cancel); act.appendChild(ok);
      body.appendChild(act); b.stack.appendChild(body);
      var close = makeClose(b.overlay, resolve);
      x.addEventListener("click", function () { close(false); });
      cancel.addEventListener("click", function () { close(false); });
      ok.addEventListener("click", function () { close(true); });
      b.overlay.addEventListener("mousedown", function (e) { if (e.target === b.overlay) close(false); });
      b.overlay.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); close(false); } });
      b.host.appendChild(b.overlay);
      setTimeout(function () { try { ok.focus(); } catch (_) {} }, 30);
    });
  }

  function alertDialog(root, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var b = build(root, opts.theme);
      var x = addHead(b.stack, opts.title || "Heads up");
      var body = el("div", "modal__panel modal__body");
      if (opts.message) { var p = el("p"); p.textContent = opts.message; body.appendChild(p); }
      var act = actions();
      var ok = btn("namebox__btn--save", "OK");
      act.appendChild(ok);
      body.appendChild(act); b.stack.appendChild(body);
      var close = makeClose(b.overlay, resolve);
      function go() { close(); }
      x.addEventListener("click", go);
      ok.addEventListener("click", go);
      b.overlay.addEventListener("mousedown", function (e) { if (e.target === b.overlay) go(); });
      b.overlay.addEventListener("keydown", function (e) { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); go(); } });
      b.host.appendChild(b.overlay);
      setTimeout(function () { try { ok.focus(); } catch (_) {} }, 30);
    });
  }

  window.RDMDialogs = { name: name, confirm: confirmDialog, alert: alertDialog };
})();
