(function(){
  window.boltivGetTransactionPin = function(){
    return new Promise(function(resolve){
      const old=document.getElementById('boltivPinModal');
      if(old) old.remove();
      const modal=document.createElement('div');
      modal.id='boltivPinModal';
      modal.innerHTML=`<div class="boltiv-pin-card"><div class="boltiv-pin-icon">🔐</div><div class="boltiv-pin-title">Enter Transaction PIN</div><div class="boltiv-pin-message">Enter your 4-digit transaction PIN to confirm this purchase.</div><div class="boltiv-pin-field"><input id="boltivPinInput" class="boltiv-pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="••••"><button id="boltivPinToggle" class="boltiv-pin-toggle" type="button" aria-label="Show Transaction PIN">SHOW</button></div><div class="boltiv-pin-actions"><button id="boltivPinCancel" type="button">CANCEL</button><button id="boltivPinConfirm" type="button">CONFIRM</button></div><a id="boltivForgotPin" href="/transaction-pin-reset.html" style="display:block;margin-top:12px;color:#b8860b;font-size:10px;font-weight:900;text-decoration:none">Forgot Transaction PIN?</a><div id="boltivPinError" class="boltiv-pin-error"></div></div>`;
      Object.assign(modal.style,{position:'fixed',inset:'0',zIndex:'100000',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px',background:'rgba(20,20,20,.55)',backdropFilter:'blur(10px)'});
      const style=document.createElement('style');
      style.textContent='#boltivPinModal .boltiv-pin-card{width:100%;max-width:360px;box-sizing:border-box;padding:28px 22px;border-radius:24px;text-align:center;background:#fffdf4;border:1px solid #e5e5e1;box-shadow:0 25px 80px rgba(0,0,0,.45)}#boltivPinModal .boltiv-pin-icon{font-size:30px;margin-bottom:12px}#boltivPinModal .boltiv-pin-title{font-size:20px;font-weight:900;color:#171717}#boltivPinModal .boltiv-pin-message{font-size:11px;line-height:1.6;color:#777;margin:8px 0 18px}#boltivPinModal .boltiv-pin-field{position:relative;width:100%;box-sizing:border-box}#boltivPinModal .boltiv-pin-input{width:100%;box-sizing:border-box;padding:15px;border:1px solid #d9d9d2;border-radius:13px;text-align:center;font-size:24px;letter-spacing:9px;font-weight:900;outline:none}#boltivPinModal .boltiv-pin-input:focus{border-color:#b8860b}#boltivPinModal .boltiv-pin-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:#b8860b;font-size:9px;font-weight:900;padding:8px;cursor:pointer}#boltivPinModal .boltiv-pin-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px}#boltivPinModal .boltiv-pin-actions button{padding:13px;border:0;border-radius:12px;font-weight:900}#boltivPinCancel{background:#eee;color:#555}#boltivPinConfirm{background:#b8860b;color:#fff}#boltivPinModal .boltiv-pin-error{min-height:16px;margin-top:10px;color:#b94c4c;font-size:10px;font-weight:700}';
      document.head.appendChild(style); document.body.appendChild(modal);
      const input=document.getElementById('boltivPinInput'), toggle=document.getElementById('boltivPinToggle'), cancel=document.getElementById('boltivPinCancel'), confirm=document.getElementById('boltivPinConfirm'), error=document.getElementById('boltivPinError');
      function finish(value){style.remove();modal.remove();resolve(value||null)}
      toggle.onclick=function(){if(input.type==='password'){input.type='text';toggle.textContent='HIDE';toggle.setAttribute('aria-label','Hide Transaction PIN')}else{input.type='password';toggle.textContent='SHOW';toggle.setAttribute('aria-label','Show Transaction PIN')}};
      cancel.onclick=function(){finish(null)};
      confirm.onclick=function(){const pin=input.value.trim(); if(!/^\d{4}$/.test(pin)){error.textContent='Enter exactly 4 digits.';input.focus();return;} finish(pin)};
      input.oninput=function(){input.value=input.value.replace(/\D/g,'').slice(0,4);error.textContent=''};
      input.onkeydown=function(e){if(e.key==='Enter')confirm.click();if(e.key==='Escape')cancel.click()};
      modal.onclick=function(e){if(e.target===modal)cancel.click()};
      setTimeout(function(){input.focus()},50);
    });
  };
})();
