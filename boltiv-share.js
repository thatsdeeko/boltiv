/* BOLTIV receipt sharing + WhatsApp support.
   - Transaction popup (transactions page) and receipt page: "SHARE RECEIPT" and "NEED HELP? WHATSAPP" buttons.
   - Dashboard: small floating WhatsApp support button.
   Read-only: it only reads what is already on screen. If anything fails, the page behaves as before. */
(function(){
  'use strict';
  var SUPPORT_NUMBER='2347086836820';
  var SITE='boltiv.ng';

  function clean(t){return String(t==null?'':t).replace(/\s+/g,' ').trim();}

  // Collect "label: value" pairs from the detail rows already rendered on the page.
  function readRows(container){
    var out=[];
    var rows=container.querySelectorAll('.detail-row,.row');
    for(var i=0;i<rows.length;i++){
      var label=rows[i].querySelector('span');
      var value=rows[i].querySelector('strong');
      if(!label||!value)continue;
      var l=clean(label.textContent),v=clean(value.textContent);
      if(!l||!v||v==='-')continue;
      if(/^provider (ref|reference)$/i.test(l))continue; // internal, not useful to share
      out.push([l,v]);
    }
    return out;
  }
  function find(rows,label){
    for(var i=0;i<rows.length;i++){if(rows[i][0].toLowerCase()===label.toLowerCase())return rows[i][1];}
    return '';
  }
  function receiptText(rows,status){
    var service=find(rows,'Service'),amount=find(rows,'Amount');
    var ok=/success/i.test(status);
    var lines=[(ok?'\u2705 ':'\uD83D\uDCC4 ')+'BOLTIV Receipt',(service?service+' ':'')+(amount?'- '+amount:'')];
    rows.forEach(function(r){
      var l=r[0].toLowerCase();
      if(l==='service'||l==='amount')return;
      lines.push(r[0]+': '+r[1]);
    });
    if(status)lines.push('Status: '+status);
    lines.push('');
    lines.push('Fast. Simple. Powerful. '+SITE);
    return lines.join('\n');
  }
  function shareText(text){
    if(navigator.share){
      navigator.share({text:text}).catch(function(){});
      return;
    }
    window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener');
  }
  function helpLink(rows,status){
    var ref=find(rows,'Reference'),service=find(rows,'Service'),amount=find(rows,'Amount');
    var msg='Hello BOLTIV support, I need help with a transaction.'+
      (service?'\nService: '+service:'')+(amount?'\nAmount: '+amount:'')+
      (ref?'\nReference: '+ref:'')+(status?'\nStatus: '+status:'');
    return 'https://wa.me/'+SUPPORT_NUMBER+'?text='+encodeURIComponent(msg);
  }

  function buildButtons(getRows,getStatus){
    var wrap=document.createElement('div');
    wrap.className='boltiv-share-actions';
    wrap.style.cssText='display:grid;gap:10px;margin:14px 0 4px;';
    var share=document.createElement('button');
    share.type='button';
    share.textContent='SHARE RECEIPT';
    share.style.cssText='border:0;border-radius:13px;padding:13px;background:#25D366;color:#fff;font-weight:900;font-size:12px;letter-spacing:.04em;cursor:pointer;';
    share.onclick=function(){
      var rows=getRows();
      if(!rows.length)return;
      shareText(receiptText(rows,getStatus()));
    };
    var help=document.createElement('a');
    help.textContent='NEED HELP? CHAT ON WHATSAPP';
    help.target='_blank';
    help.rel='noopener noreferrer';
    help.style.cssText='display:block;text-align:center;border:1px solid #e5e5e1;border-radius:13px;padding:12px;background:#fff;color:#171717;font-weight:900;font-size:11px;text-decoration:none;';
    help.onclick=function(){help.href=helpLink(getRows(),getStatus());};
    help.href='https://wa.me/'+SUPPORT_NUMBER;
    wrap.appendChild(share);
    wrap.appendChild(help);
    return wrap;
  }

  /* ---------- transactions page popup ---------- */
  function mountPopup(){
    var details=document.getElementById('modalDetails');
    if(!details||!details.parentNode)return;
    var statusEl=document.getElementById('modalStatus');
    function place(){
      var old=document.querySelector('.boltiv-share-actions');
      if(old)old.remove();
      if(!details.querySelector('.detail-row'))return;
      var anchor=document.getElementById('transactionNote')||details;
      var rows0=readRows(details);
      if(!find(rows0,'Reference'))return;
      var buttons=buildButtons(function(){return readRows(details);},function(){return statusEl?clean(statusEl.textContent).replace(/^[^A-Za-z]+/,''):'';});
      anchor.parentNode.insertBefore(buttons,anchor.nextSibling);
    }
    // the page rewrites modalDetails each time a transaction is opened
    new MutationObserver(function(){setTimeout(place,0);}).observe(details,{childList:true});
  }

  /* ---------- receipt page ---------- */
  function mountReceipt(){
    var details=document.getElementById('details');
    if(!details||!details.parentNode||!document.querySelector('.receipt-card'))return;
    var statusEl=document.getElementById('status');
    new MutationObserver(function(){
      if(document.querySelector('.boltiv-share-actions'))return;
      if(!details.querySelector('.row'))return;
      var buttons=buildButtons(function(){return readRows(details);},function(){return statusEl?clean(statusEl.textContent):'';});
      details.parentNode.insertBefore(buttons,details.nextSibling);
    }).observe(details,{childList:true});
  }

  /* ---------- dashboard floating support button ---------- */
  function mountFloating(){
    if(!document.querySelector('.home-balance-card')||document.getElementById('boltivWhatsappFab'))return;
    var a=document.createElement('a');
    a.id='boltivWhatsappFab';
    a.href='https://wa.me/'+SUPPORT_NUMBER+'?text='+encodeURIComponent('Hello BOLTIV support, I need help.');
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.setAttribute('aria-label','Chat with BOLTIV support on WhatsApp');
    a.style.cssText='position:fixed;right:16px;bottom:calc(92px + env(safe-area-inset-bottom,0px));width:52px;height:52px;border-radius:50%;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.28);z-index:900;text-decoration:none;';
    a.innerHTML='<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.7-5A8.4 8.4 0 1 1 21 11.5Z"/><path d="M8.5 10h7M8.5 13.500h4.5"/></svg>';
    document.body.appendChild(a);
  }

  function start(){
    try{mountPopup();}catch(e){}
    try{mountReceipt();}catch(e){}
    try{mountFloating();}catch(e){}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
