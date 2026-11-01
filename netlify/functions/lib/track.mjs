// Мітки й піксели: налаштування, безпечний вивід у сторінку і скрипт, що вантажить їх (з урахуванням згоди на cookie)
export const DEFAULT_TRACK = { gtm: "", fb: "", tt: "", adsId: "", adsLabel: "", clarity: "", headCode: "", bodyCode: "", consent: false, consentText: "" };

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// Повертає { value } або { error }. Порожнє поле = «не використовувати»
export function sanitizeTrack(raw) {
  const r = raw || {}, t = { ...DEFAULT_TRACK };
  const pick = (key, label, re, max, hint, upper) => {
    let v = clean(r[key], max);
    if (upper) v = v.toUpperCase();
    if (v && !re.test(v)) return `${label}: ${hint}`;
    t[key] = v; return "";
  };
  const errs = [
    pick("gtm", "Google Tag Manager", /^GTM-[A-Z0-9]{4,10}$/, 20, "ідентифікатор має вигляд GTM-XXXXXXX", true),
    pick("fb", "Meta Pixel", /^\d{8,20}$/, 30, "потрібен числовий ідентифікатор (лише цифри)"),
    pick("tt", "TikTok Pixel", /^[A-Za-z0-9]{10,30}$/, 40, "ідентифікатор складається з 10–30 літер і цифр", true),
    pick("adsId", "Google Ads", /^AW-\d{6,14}$/, 24, "ідентифікатор має вигляд AW-123456789", true),
    pick("adsLabel", "Мітка конверсії Google Ads", /^[A-Za-z0-9_-]{6,40}$/, 40, "лише літери, цифри, «-» і «_»"),
    pick("clarity", "Microsoft Clarity", /^[a-z0-9]{8,14}$/, 20, "ідентифікатор складається з 8–14 малих літер і цифр"),
  ].filter(Boolean);
  if (errs.length) return { error: errs[0] };
  t.headCode = String(r.headCode ?? "").replace(/\r/g, "").slice(0, 8000).trim();
  t.bodyCode = String(r.bodyCode ?? "").replace(/\r/g, "").slice(0, 8000).trim();
  t.consent = r.consent === true;
  t.consentText = clean(r.consentText, 220);
  return { value: t };
}

// Мета-теги та link (підтвердження доменів тощо) мають бути в самому коді сторінки, решта вантажиться скриптом
export function splitHeadCode(code) {
  const raw = [];
  const rest = String(code || "").replace(/<(meta|link)\b[^>]*>/gi, (m) => { raw.push(m); return ""; }).trim();
  return { raw, rest };
}

export function trackClientConfig(site) {
  const t = site.track || DEFAULT_TRACK;
  return {
    ga: site.seo.gaId || "", gtm: t.gtm, fb: t.fb, tt: t.tt, adsId: t.adsId, adsLabel: t.adsLabel, clarity: t.clarity,
    head: splitHeadCode(t.headCode).rest, body: t.bodyCode, consent: !!t.consent, consentText: t.consentText || "",
  };
}
export function hasTrackers(site) {
  const c = trackClientConfig(site);
  return !!(c.ga || c.gtm || c.fb || c.tt || c.adsId || c.clarity || c.head || c.body || splitHeadCode(site.track?.headCode).raw.length);
}

export const TRACKER_JS = String.raw`(function(){
var C=window.__TRACK__||{},D=document,loaded=false,pending=false,q=[],KEY='alc_consent';
if(!(C.ga||C.gtm||C.fb||C.tt||C.adsId||C.clarity||C.head||C.body)){window.alcTrack=function(){};return;}
function sc(src){var s=D.createElement('script');s.async=true;s.src=src;D.head.appendChild(s);}
function inject(html){
  if(!html)return;
  var t=D.createElement('template');t.innerHTML=html;
  var n=t.content.childNodes,i,x,j,a,s;
  for(i=0;i<n.length;i++){x=n[i];
    if(x.nodeName==='SCRIPT'){s=D.createElement('script');for(j=0;j<x.attributes.length;j++){a=x.attributes[j];s.setAttribute(a.name,a.value);}s.text=x.text||x.textContent;D.head.appendChild(s);}
    else if(x.nodeType===1){D.body.appendChild(x.cloneNode(true));}
  }
}
function send(n,d){
  var w=window,v=+d.price||0,cur='UAH',it=[{item_id:d.id,item_name:d.name,price:v}],m;
  if(C.gtm&&w.dataLayer)w.dataLayer.push({event:n,ecommerce:{currency:cur,value:v,items:it}});
  if(w.gtag){m={view_item:'view_item',begin_order:'begin_checkout',lead:'generate_lead'}[n];if(m)w.gtag('event',m,{currency:cur,value:v,items:it});
    if(n==='lead'&&C.adsId&&C.adsLabel)w.gtag('event','conversion',{send_to:C.adsId+'/'+C.adsLabel,value:v,currency:cur});}
  if(w.fbq){m={view_item:'ViewContent',begin_order:'InitiateCheckout',lead:'Lead'}[n];if(m)w.fbq('track',m,{content_ids:[d.id],content_name:d.name,content_type:'product',value:v,currency:cur});}
  if(w.ttq){m={view_item:'ViewContent',begin_order:'InitiateCheckout',lead:'SubmitForm'}[n];if(m)w.ttq.track(m,{content_id:d.id,content_name:d.name,content_type:'product',value:v,currency:cur});}
}
function load(){
  if(loaded)return;loaded=true;pending=false;
  var w=window,k;w.dataLayer=w.dataLayer||[];
  if(C.gtm){w.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});sc('https://www.googletagmanager.com/gtm.js?id='+encodeURIComponent(C.gtm));}
  if(C.ga||C.adsId){w.gtag=function(){w.dataLayer.push(arguments);};w.gtag('js',new Date());sc('https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(C.ga||C.adsId));if(C.ga)w.gtag('config',C.ga);if(C.adsId)w.gtag('config',C.adsId);}
  if(C.fb){(function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=true;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=true;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s);})(w,D,'script','https://connect.facebook.net/en_US/fbevents.js');w.fbq('init',C.fb);w.fbq('track','PageView');}
  if(C.tt){(function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)));};};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e;};ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement('script');o.type='text/javascript';o.async=true;o.src=i+'?sdkid='+e+'&lib='+t;var a=d.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a);};ttq.load(C.tt);ttq.page();})(w,D,'ttq');}
  if(C.clarity){(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments);};t=l.createElement(r);t.async=1;t.src='https://www.clarity.ms/tag/'+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(w,D,'clarity','script',C.clarity);}
  inject(C.head);inject(C.body);
  for(k=0;k<q.length;k++)send(q[k][0],q[k][1]);q=[];
}
function decide(v){try{localStorage.setItem(KEY,v);}catch(e){}}
function banner(){
  if(D.getElementById('alc-consent'))return;
  var b=D.createElement('div');b.id='alc-consent';b.setAttribute('role','dialog');b.setAttribute('aria-label','Cookie');
  b.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:300;max-width:560px;margin:0 auto;padding:14px 16px;border-radius:16px;background:#1b2552;color:#eef0ff;font:600 15px/1.45 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35)';
  var p=D.createElement('p');p.style.margin='0 0 12px';p.textContent=C.consentText||'Ми використовуємо cookie для статистики й реклами. Це допомагає нам показувати потрібні костюми.';
  function btn(t,bg,fg,fn){var x=D.createElement('button');x.type='button';x.setAttribute('data-consent',t);x.textContent=t;x.style.cssText='min-height:44px;padding:0 20px;margin-right:8px;border:0;border-radius:12px;font:800 15px system-ui,sans-serif;cursor:pointer;background:'+bg+';color:'+fg;x.onclick=function(){b.parentNode&&b.parentNode.removeChild(b);fn();};return x;}
  b.appendChild(p);
  b.appendChild(btn('Погоджуюсь','#f1c75b','#1b2046',function(){decide('1');load();}));
  b.appendChild(btn('Відхилити','#fff','#1b2552',function(){decide('0');pending=false;q=[];}));
  D.body.appendChild(b);
}
window.alcTrack=function(n,d){d=d||{};if(loaded)send(n,d);else if(pending)q.push([n,d]);};
var st=null;try{st=localStorage.getItem(KEY);}catch(e){}
if(!C.consent||st==='1'){load();}
else if(st!=='0'){pending=true;if(D.body)banner();else D.addEventListener('DOMContentLoaded',banner);}
})();`;

// Усе, що вставляється в <head>: налаштування, скрипт і мета-теги підтвердження
export function trackerHead(site) {
  if (!hasTrackers(site)) return "";
  const raw = splitHeadCode(site.track?.headCode).raw.join("\n");
  return [raw, `<script>window.__TRACK__=${jsonSafe(trackClientConfig(site))};</script>`, `<script>${TRACKER_JS}</script>`].filter(Boolean).join("\n");
}
export const trackEventScript = (d) => `<script>window.alcTrack&&window.alcTrack('view_item',${jsonSafe(d)});</script>`;
