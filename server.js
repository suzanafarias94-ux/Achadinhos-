import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
let amazonToken = null;
let amazonTokenExpires = 0;

function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'cache-control':'no-store', 'x-content-type-options':'nosniff'});
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function cleanUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('Cole um endereço válido de produto.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Endereço inválido.');
  const host = u.hostname.toLowerCase();
  const allowed = /(^|\.)(amazon\.com\.br|amazon\.com|amzn\.to|shopee\.com\.br|s\.shopee\.com\.br|shein\.com|onelink\.shein\.com|mercadolivre\.com\.br|meli\.la)$/i.test(host);
  if (!allowed) throw new Error('Por enquanto, aceito links da Amazon, Shopee, SHEIN e Mercado Livre.');
  return u;
}
function marketOf(u) {
 const h=u.hostname.toLowerCase();
 if(h.includes('amazon')||h==='amzn.to') return 'amazon';
 if(h.includes('shopee')) return 'shopee';
 if(h.includes('shein')) return 'shein';
 if(h.includes('mercadolivre')||h==='meli.la') return 'mercado_livre';
 return 'unknown';
}
async function resolveUrl(u) {
 try { const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; Achadinhos/1.0)'}}); return new URL(r.url); }
 catch { return u; }
}
function money(v) {
 if(v==null || v==='') return null;
 const n=Number(v); return Number.isFinite(n)&&n>0?n:null;
}
function formatProduct(data, platform, url) {
 const original=money(data.price_original ?? data.original_price);
 const price=money(data.price ?? data.current_price);
 const discount=original&&price&&original>price?`${Math.round((1-price/original)*100)}%`:'';
 return {platform, title:data.title||data.name||'', price, originalPrice:original, discount,
   image:data.image||data.images?.[0]||'', seller:data.seller||'', rating:data.rating||'', sold:data.sold||'',
   productUrl:url.toString(), affiliateUrl:data.affiliateUrl||url.toString(), source:data.source||'metadata'};
}
function getAsin(u) { const m=(u.pathname+' '+u.search).match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/)([A-Z0-9]{10})|\b([A-Z0-9]{10})\b/i); return (m?.[1]||m?.[2]||'').toUpperCase(); }
async function amazonGetToken() {
 if(amazonToken && Date.now()<amazonTokenExpires-60000) return amazonToken;
 const id=process.env.AMAZON_CLIENT_ID, secret=process.env.AMAZON_CLIENT_SECRET;
 if(!id||!secret) throw new Error('A integração da Amazon precisa ser configurada no servidor com as credenciais da Creators API.');
 const version=process.env.AMAZON_CREDENTIAL_VERSION||'3.1';
 const endpoint=version.startsWith('3.2')?'https://api.amazon.co.uk/auth/o2/token':version.startsWith('3.3')?'https://api.amazon.co.jp/auth/o2/token':'https://api.amazon.com/auth/o2/token';
 const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:id,client_secret:secret,scope:'creatorsapi::default'})});
 const j=await r.json(); if(!r.ok||!j.access_token) throw new Error(j.error_description||j.error||'Não foi possível autenticar na Amazon.');
 amazonToken=j.access_token; amazonTokenExpires=Date.now()+(Number(j.expires_in)||3600)*1000; return amazonToken;
}
async function amazonLookup(u) {
 const asin=getAsin(u); if(!asin) throw new Error('Não consegui identificar o ASIN nesse link da Amazon.');
 const tag=process.env.AMAZON_PARTNER_TAG; if(!tag) throw new Error('Configure a tag de Associado da Amazon no servidor.');
 const token=await amazonGetToken();
 const payload={itemIds:[asin],itemIdType:'ASIN',marketplace:'www.amazon.com.br',partnerTag:tag,resources:['images.primary.large','itemInfo.title','offersV2.listings.price','offersV2.listings.savingBasis']};
 const r=await fetch('https://creatorsapi.amazon/catalog/v1/getItems',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-marketplace':'www.amazon.com.br'},body:JSON.stringify(payload)});
 const j=await r.json(); if(!r.ok) throw new Error(j.errors?.[0]?.message||'A Amazon não retornou os dados do produto.');
 const item=j.itemsResult?.items?.[0]; if(!item) throw new Error('Produto não encontrado na Creators API da Amazon.');
 const offer=item.offersV2?.listings?.[0];
 return formatProduct({title:item.itemInfo?.title?.displayValue, image:item.images?.primary?.large?.url||item.images?.primary?.medium?.url,
   price:offer?.price?.money?.amount, original_price:offer?.savingBasis?.money?.amount,
   affiliateUrl:item.detailPageURL||u.toString(), source:'Amazon Creators API'},'amazon',u);
}
function meliId(u) {
 const all=[u.pathname,u.search,u.hash].join(' ');
 return (all.match(/MLB-?(\d{6,})/i)||[])[1] ? `MLB${(all.match(/MLB-?(\d{6,})/i)||[])[1]}` : '';
}
async function mercadoLivreLookup(u) {
 const id=meliId(u); if(!id) throw new Error('Não consegui identificar o código do anúncio do Mercado Livre.');
 const headers={accept:'application/json'}; if(process.env.MELI_ACCESS_TOKEN) headers.authorization=`Bearer ${process.env.MELI_ACCESS_TOKEN}`;
 const r=await fetch(`https://api.mercadolibre.com/items/${id}`,{headers}); const j=await r.json();
 if(!r.ok) throw new Error(j.message||'O Mercado Livre não retornou os dados deste anúncio.');
 let description='';
 try { const d=await fetch(`https://api.mercadolibre.com/items/${id}/description`,{headers}); if(d.ok) description=(await d.json()).plain_text||''; } catch {}
 return formatProduct({title:j.title,price:j.price,original_price:j.original_price,image:j.thumbnail?.replace(/-I\./,'-O.'),seller:j.seller_id?`Vendedor ${j.seller_id}`:'',
   affiliateUrl:u.toString(),source:'API do Mercado Livre'},'mercado_livre',u);
}
function parseMeta(html, base) {
 const get=(...names)=>{ for(const name of names){ const re=new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']`,'i'); const m=html.match(re); if(m) return (m[1]||m[2]||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'"); } return ''; };
 const title=get('og:title','twitter:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
 const image=get('og:image','twitter:image'); const desc=get('og:description','description');
 const p=get('product:price:amount','og:price:amount'); const currency=get('product:price:currency','og:price:currency');
 return {title,image:image?new URL(image,base).toString():'',description:desc,price:currency&&currency!=='BRL'?null:p};
}
async function metadataLookup(u, platform) {
 const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1','accept':'text/html,application/xhtml+xml'}});
 if(!r.ok) throw new Error(`A loja bloqueou a consulta automática (HTTP ${r.status}).`);
 const html=(await r.text()).slice(0,2_000_000); const meta=parseMeta(html,r.url);
 if(!meta.title && !meta.image) throw new Error('A loja não disponibilizou os dados do produto para leitura automática.');
 return formatProduct({...meta,source:'Metadados públicos da página'},platform,new URL(r.url));
}
async function productLookup(raw) {
 const input=cleanUrl(raw); const resolved=await resolveUrl(input); cleanUrl(resolved.toString()); const platform=marketOf(resolved);
 if(platform==='amazon') return amazonLookup(resolved);
 if(platform==='mercado_livre') return mercadoLivreLookup(resolved);
 if(platform==='shopee'||platform==='shein') return metadataLookup(resolved,platform);
 throw new Error('Loja não reconhecida.');
}
const server=http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});return res.end();}
 if(req.url==='/api/health') return send(res,200,{ok:true,service:'Achadinhos'});
 if(req.url==='/api/product'&&req.method==='POST'){
   let body=''; for await(const chunk of req) body+=chunk;
   try { const {url}=JSON.parse(body||'{}'); if(typeof url!=='string'||!url.trim()) return send(res,400,{error:'Cole o link do produto.'});
     const product=await productLookup(url.trim()); return send(res,200,{product});
   } catch(e){ return send(res,422,{error:e.message||'Não foi possível consultar esse produto.'}); }
 }
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=pathname==='/'?'index.html':normalize(pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
 const full=join(ROOT,'public',file);
 try { const data=await readFile(full); const ext=extname(full); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'}; send(res,200,data,types[ext]||'application/octet-stream'); }
 catch { send(res,404,{error:'Não encontrado.'}); }
});
server.listen(PORT,()=>console.log(`Achadinhos disponível em http://localhost:${PORT}`));
