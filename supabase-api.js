/* CERISH CRM V14 — lớp API phía trình duyệt, lưu dữ liệu qua Supabase.
 * Backend: các hàm RPC trong Postgres (file CERISH_CRM_V14/supabase-schema.sql).
 * Đăng nhập kiểm tra ở server (bcrypt), phiên hết hạn sau 12 giờ.
 * Cấu hình trong index.html TRƯỚC khi nạp file này:
 *   window.CERISH_SUPABASE_URL = 'https://xxxxx.supabase.co';
 *   window.CERISH_SUPABASE_ANON_KEY = 'eyJ...'; */
(function(){
'use strict';
var SB_URL=(window.CERISH_SUPABASE_URL||'').replace(/\/$/,'');
var SB_KEY=window.CERISH_SUPABASE_ANON_KEY||'';
var TOKEN_KEY='cerish_crm_token';

var TABLES={
 partners:["name","type","platform","handle","phone","email","followers","stage","commission","owner","notes","activity_mode","live_groups","video_groups"],
 bookings:["partner_id","contact_date","campaign","campaign_id","product","booking_fee","commission","deal_type","deal_details","deadline","video_date","live_date","video_url","booking_note","status","owner","notes","content_type","video_status","live_status"],
 products:["name","sku","category","launch_date","booking_owner","status","notes"],
 campaigns:["name","product","sku","product_id","target_koc","target_kol","target_videos","target_lives","start_date","end_date","owner","status","notes"],
 samples:["partner_id","product","product_id","quantity","sent_date","received_date","tracking_code","status","owner","notes"],
 videos:["booking_id","partner_id","title","platform","url","posted_date","views","orders","gmv","status","notes"],
 lives:["partner_id","title","session_date","duration_minutes","views","orders","gmv","commission","status","notes"],
 tasks:["partner_id","title","due_date","priority","status","owner","notes"],
 customers:["name","phone","channel","orders","spent","segment","owner","notes"]
};
var STATUS={
 partners:["Tiềm năng","Đã liên hệ","Đang đàm phán","Đang hợp tác","Tạm dừng","Ngừng hợp tác"],
 bookings:["Đề xuất","Đang đàm phán","Đã chốt","Đang thực hiện","Hoàn thành","Đã hủy"],
 products:["Chuẩn bị","Đang booking","Đang bán","Tạm dừng","Ngừng bán"],
 campaigns:["Chuẩn bị","Đang chạy","Tạm dừng","Hoàn thành"],
 samples:["Chuẩn bị","Đã gửi","Đang vận chuyển","Đã nhận","Đã hủy"],
 videos:["Chờ đăng","Đã đăng","Cần chỉnh sửa","Đã gỡ"],
 lives:["Dự kiến","Đã diễn ra","Đã hủy"],
 tasks:["Cần làm","Đang làm","Hoàn thành","Quá hạn"]
};
var DATA_TABLES=['partners','bookings','products','campaigns','samples','videos','lives','tasks','customers','audit_logs'];
var NUMERIC={followers:1,quantity:1,views:1,orders:1,duration_minutes:1,target_koc:1,target_kol:1,target_videos:1,target_lives:1};
var MONEY={booking_fee:1,commission:1,gmv:1,spent:1};
var IDFIELDS={id:1,partner_id:1,campaign_id:1,product_id:1,booking_id:1,user_id:1,entity_id:1,active:1};
var SEARCH_SKIP={partner_id:1,followers:1,commission:1,booking_fee:1,quantity:1,views:1,orders:1,gmv:1,duration_minutes:1,spent:1};

function pad(n){return (n<10?'0':'')+n}
function isoDate(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function dayOffset(delta){var d=new Date();d.setDate(d.getDate()+delta);return isoDate(d)}
function now(){var d=new Date();return isoDate(d)+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}
function today(){return isoDate(new Date())}
var _lastId=0;
function newId(){var t=Date.now();if(t<=_lastId)t=_lastId+1;_lastId=t;return t}

function HttpError(status,detail){this.status=status;this.detail=detail}
function jres(body,status){return new Response(JSON.stringify(body),{status:status||200,headers:{'Content-Type':'application/json'}})}

function getToken(){try{return localStorage.getItem(TOKEN_KEY)||''}catch(e){return ''}}
function setToken(t){try{if(!t)localStorage.removeItem(TOKEN_KEY);else localStorage.setItem(TOKEN_KEY,t)}catch(e){}}

var realFetch=window.fetch.bind(window);
async function rpc(fn,args){
 if(!SB_URL||!SB_KEY)throw new HttpError(503,'Web chưa được cấu hình Supabase. Liên hệ quản trị viên.');
 // Key JWT cũ (eyJ...) mới gửi kèm Authorization; key mới sb_... CHỈ dùng apikey
 // (gửi sb_ qua Authorization Bearer sẽ bị Supabase báo "Invalid JWT").
 var headers={'Content-Type':'application/json','apikey':SB_KEY};
 if(SB_KEY.indexOf('eyJ')===0)headers['Authorization']='Bearer '+SB_KEY;
 var res;
 try{
  res=await realFetch(SB_URL+'/rest/v1/rpc/'+fn,{method:'POST',headers:headers,body:JSON.stringify(args||{})});
 }catch(e){throw new HttpError(503,'Không kết nối được Supabase. Kiểm tra mạng rồi thử lại.')}
 var out;
 try{out=await res.json()}catch(e){throw new HttpError(502,'Supabase trả về phản hồi không hợp lệ.')}
 if(out&&typeof out==='object'&&out.ok===undefined&&res.status>=400)
  throw new HttpError(res.status,out.message||out.hint||'Lỗi Supabase');
 if(!out||!out.ok){
  if(out&&Number(out.code)===401){setToken('');sessionUser=null}
  throw new HttpError((out&&Number(out.code))||500,(out&&out.error)||'Thao tác thất bại');
 }
 return out;
}

// ===== Bản sao dữ liệu trong bộ nhớ =====
var db={};DATA_TABLES.concat(['users']).forEach(function(n){db[n]=[]});
var sessionUser=null;
var dumped=false;
function normalizeRec(table,o){
 var r={};
 Object.keys(o).forEach(function(k){
  var v=o[k];
  if(IDFIELDS[k]||NUMERIC[k]||MONEY[k]){
   if(v===''||v==null)v=(k==='partner_id'&&table==='tasks')?null:0;
   else v=Number(v)||0;
  } else v=v==null?'':String(v);
  r[k]=v;
 });
 if(Number(r.id)>_lastId)_lastId=Number(r.id);
 return r;
}
async function ensureData(force){
 if(dumped&&!force)return;
 var out=await rpc('cerish_dump',{p_token:getToken()});
 var tables=out.tables||{};
 DATA_TABLES.concat(['users']).forEach(function(t){
  db[t]=(tables[t]||[]).map(function(o){return normalizeRec(t,o)});
 });
 dumped=true;
}
async function putDoc(table,rec){await rpc('cerish_put',{p_token:getToken(),p_table:table,p_record:rec})}
async function dropDoc(table,id){await rpc('cerish_del',{p_token:getToken(),p_table:table,p_id:Number(id)})}

function currentUser(){
 if(!sessionUser)throw new HttpError(401,'Vui lòng đăng nhập');
 return sessionUser;
}
function adminOnly(){var u=currentUser();if(u.role!=='admin')throw new HttpError(403,'Chỉ quản trị viên có quyền');return u}
function log(user,action,entity,eid,details){
 var entry={id:newId(),user_id:user.id,action:action,entity:entity,entity_id:eid,details:String(details||'').slice(0,2000),created_at:now()};
 db.audit_logs.push(entry);
 putDoc('audit_logs',entry).catch(function(){});
}
function byId(table,id){return db[table].filter(function(r){return Number(r.id)===Number(id)})[0]}
function daysLeft(deadline){
 if(!deadline)return null;
 var a=new Date(deadline+'T00:00:00'),b=new Date(today()+'T00:00:00');
 return Math.round((a-b)/86400000);
}
function groupHas(val,name){return ('|'+(val||'')+'|').indexOf('|'+name+'|')>=0}

function validate(table,values,update){
 if(!TABLES[table])throw new HttpError(404,'Không tìm thấy phân hệ');
 if(!values||typeof values!=='object')throw new HttpError(422,'Dữ liệu không hợp lệ');
 var required={partners:'name',bookings:'partner_id',campaigns:'name',products:'name',samples:'product',videos:'title',lives:'title',tasks:'title',customers:'name'}[table];
 if(!update&&!String(values[required]==null?'':values[required]).trim())throw new HttpError(422,'Thiếu trường bắt buộc: '+required);
 if((required in values)&&!String(values[required]==null?'':values[required]).trim())throw new HttpError(422,'Tên hoặc tiêu đề không được để trống');
 var out={};
 Object.keys(values).forEach(function(key){
  if(TABLES[table].indexOf(key)<0)return;
  var val=values[key];if(val==null)val='';
  if(NUMERIC[key]){val=parseInt(val||0,10);if(isNaN(val))throw new HttpError(422,key+' phải là số nguyên');if(val<0)throw new HttpError(422,key+' không được âm')}
  else if(MONEY[key]){val=parseFloat(val||0);if(isNaN(val))throw new HttpError(422,key+' phải là số');if(val<0)throw new HttpError(422,key+' không được âm');if(key==='commission'&&val>100)throw new HttpError(422,'Hoa hồng phải từ 0–100%')}
  else if(key==='campaign_id'||key==='product_id'||key==='booking_id'){val=parseInt(val||0,10);if(isNaN(val)||val<0)throw new HttpError(422,'Chiến dịch không hợp lệ')}
  else if(key==='partner_id'){
   if(val===''&&table==='tasks')val=null;
   else{val=parseInt(val,10);if(isNaN(val))throw new HttpError(422,'Đối tác không hợp lệ')}
  }
  else val=String(val).trim().slice(0,key==='notes'?3000:500);
  if(key==='status'&&STATUS[table]&&STATUS[table].indexOf(val)<0)throw new HttpError(422,'Trạng thái không hợp lệ');
  if(key==='activity_mode'&&table==='partners'&&val&&['Live','Video','Cả hai'].indexOf(val)<0)throw new HttpError(422,'Hình thức hoạt động không hợp lệ');
  if(key==='stage'&&table==='partners'&&STATUS.partners.indexOf(val)<0)throw new HttpError(422,'Giai đoạn không hợp lệ');
  if((key==='url'||key==='video_url')&&val&&!(val.indexOf('https://')===0||val.indexOf('http://')===0))throw new HttpError(422,'Link video phải bắt đầu bằng https:// hoặc http://');
  out[key]=val;
 });
 if(!Object.keys(out).length)throw new HttpError(422,'Chưa có dữ liệu');
 return out;
}
function checkCampaign(table,data){
 if((table==='campaigns'||table==='samples')&&Number(data.product_id||0)){
  var product=byId('products',data.product_id);
  if(!product)throw new HttpError(422,'Sản phẩm được chọn không tồn tại');
  if(table==='campaigns'){data.product=product.name;data.sku=product.sku;data.owner=product.booking_owner}
  else if(!data.product)data.product=product.name;
 }
 if(table==='bookings'&&Number(data.campaign_id||0)){
  var campaign=byId('campaigns',data.campaign_id);
  if(!campaign)throw new HttpError(422,'Chiến dịch được chọn không tồn tại');
  data.campaign=campaign.name;data.product=campaign.product;
  var p=campaign.product_id?byId('products',campaign.product_id):null;
  if(p&&p.booking_owner)data.owner=p.booking_owner;
 }
}
function checkVideoBooking(table,data,old){
 if(table!=='videos')return;
 var bookingId=Number((data.booking_id!=null?data.booking_id:(old?old.booking_id:0))||0);
 if(!bookingId)return;
 var booking=byId('bookings',bookingId);
 if(!booking)throw new HttpError(422,'Booking liên kết không tồn tại');
 if('partner_id' in data&&Number(data.partner_id)!==Number(booking.partner_id))throw new HttpError(422,'KOC trong video không khớp booking');
 data.partner_id=booking.partner_id;
}
function checkPartner(data){
 if('partner_id' in data&&data.partner_id!=null){
  if(!byId('partners',data.partner_id))throw new HttpError(422,'Đối tác không tồn tại');
 }
}
// Chặn trùng KOC: trùng tên kênh hoặc trùng ID kênh đều bị từ chối.
function checkPartnerDuplicate(data,excludeId){
 var name=String(data.name||'').trim().toLowerCase();
 var handle=String(data.handle||'').trim().toLowerCase();
 if(!name&&!handle)return;
 var dup=db.partners.filter(function(p){
  if(excludeId!=null&&Number(p.id)===Number(excludeId))return false;
  if(handle&&String(p.handle||'').trim().toLowerCase()===handle)return true;
  if(name&&String(p.name||'').trim().toLowerCase()===name)return true;
  return false;
 })[0];
 if(dup)throw new HttpError(409,'Trùng KOC: "'+(dup.name||dup.handle)+'" đã có trong danh sách (trùng tên kênh hoặc ID kênh). Không được tạo thêm.');
}
async function sampleFollowup(user,partnerId,owner){
 var reminder='Theo dõi KOC sau khi nhận mẫu';
 var exists=db.tasks.some(function(t){return Number(t.partner_id)===Number(partnerId)&&t.title===reminder&&t.status!=='Hoàn thành'});
 if(exists)return;
 var stamp=now();
 var rec={id:newId(),partner_id:partnerId,title:reminder,due_date:dayOffset(2),priority:'Cao',status:'Cần làm',owner:owner||'',notes:'Tự động tạo khi đối tác xác nhận nhận hàng mẫu.',created_at:stamp,updated_at:stamp};
 try{await putDoc('tasks',rec);db.tasks.push(rec);log(user,'auto_create','tasks',rec.id,'sample_received_followup')}catch(e){}
}

function listItems(table,q){
 currentUser();
 if(!TABLES[table])throw new HttpError(404,'Không tìm thấy phân hệ');
 var page=Math.max(1,parseInt(q.get('page')||1,10)||1);
 var perPage=Math.max(1,Math.min(1000,parseInt(q.get('per_page')||10,10)||10));
 var search=(q.get('q')||'').trim().toLowerCase().slice(0,100);
 var status=q.get('status')||'';
 var hasPartner=TABLES[table].indexOf('partner_id')>=0;
 var rows=db[table].filter(function(t){
  if(search){
   var hit=TABLES[table].some(function(f){
    if(SEARCH_SKIP[f])return false;
    return String(t[f]==null?'':t[f]).toLowerCase().indexOf(search)>=0;
   });
   if(!hit&&table==='bookings'){
    var p=byId('partners',t.partner_id)||{};
    hit=[p.name,p.handle,p.phone].some(function(v){return String(v||'').toLowerCase().indexOf(search)>=0});
   }
   if(!hit)return false;
  }
  var statefield=table==='partners'?'stage':STATUS[table]?'status':table==='customers'?'segment':'';
  if(status&&statefield&&t[statefield]!==status)return false;
  if(table==='partners'){
   var lg=q.get('live_group')||'',vg=q.get('video_group')||'',activity=q.get('activity')||'',pg=q.get('product_group')||'';
   if(lg&&!groupHas(t.live_groups,lg))return false;
   if(vg&&!groupHas(t.video_groups,vg))return false;
   if(activity==='Cả hai'){if(t.activity_mode!=='Cả hai')return false}
   else if(activity==='Live'||activity==='Video'){if([activity,'Cả hai'].indexOf(t.activity_mode)<0)return false}
   if(pg){
    var inLive=groupHas(t.live_groups,pg),inVideo=groupHas(t.video_groups,pg);
    if(activity==='Live'){if(!inLive)return false}
    else if(activity==='Video'){if(!inVideo)return false}
    else if(!inLive&&!inVideo)return false;
   }
  }
  if(q.get('campaign_id')!=null&&table==='bookings'&&Number(t.campaign_id||0)!==Number(q.get('campaign_id')))return false;
  if(q.get('booking_id')!=null&&table==='videos'&&Number(t.booking_id||0)!==Number(q.get('booking_id')))return false;
  if(q.get('partner_id')!=null&&hasPartner&&Number(t.partner_id)!==Number(q.get('partner_id')))return false;
  return true;
 });
 rows=rows.slice().sort(function(a,b){return b.id-a.id});
 var total=rows.length;
 rows=rows.slice((page-1)*perPage,(page-1)*perPage+perPage).map(function(t){
  var r=Object.assign({},t);
  if(hasPartner){
   var p=byId('partners',t.partner_id)||{};
   r.partner_name=p.name||null;
   if(table==='bookings'){r.partner_handle=p.handle||null;r.partner_phone=p.phone||null;r.partner_followers=p.followers||null;r.partner_platform=p.platform||null}
  }
  if(table==='bookings'){r.kpi_target=Math.round((t.booking_fee||0)/20*100);r.days_left=daysLeft(t.deadline)}
  return r;
 });
 return {rows:rows,total:total,page:page,per_page:perPage};
}

async function handle(path,opts){
 var url=new URL(path,location.href);
 var q=url.searchParams;
 var parts=url.pathname.replace(/^\/+/,'').split('/');
 var ai=parts.indexOf('api');
 if(ai>0)parts=parts.slice(ai);
 var method=(opts.method||'GET').toUpperCase();
 var body=null;
 if(opts.body){try{body=JSON.parse(opts.body)}catch(e){throw new HttpError(422,'Dữ liệu không hợp lệ')}}

 if(parts[1]==='login'&&method==='POST'){
  var out=await rpc('cerish_login',{p_email:String((body&&body.email)||'').trim(),p_password:String((body&&body.password)||'')});
  setToken(out.token);sessionUser=out.user;
  await ensureData(true);
  return {user:out.user};
 }
 if(parts[1]==='logout'&&method==='POST'){
  var t=getToken();setToken('');sessionUser=null;dumped=false;
  if(t)rpc('cerish_logout',{p_token:t}).catch(function(){});
  return {ok:true};
 }
 if(parts[1]==='me'){
  if(!sessionUser){
   if(!getToken())throw new HttpError(401,'Vui lòng đăng nhập');
   var meOut=await rpc('cerish_me',{p_token:getToken()});
   sessionUser=meOut.user;
  }
  await ensureData();
  return sessionUser;
 }
 if(parts[1]==='config'){currentUser();return {brand:'CERISH',statuses:STATUS,demo:false}}

 if(parts[1]==='users'&&!parts[2]){
  if(method==='GET'){adminOnly();return {rows:db.users.slice()}}
  if(method==='POST'){
   adminOnly();
   var created=await rpc('cerish_user_create',{p_token:getToken(),p_name:body.name,p_email:body.email,p_password:body.password,p_role:body.role||'staff'});
   db.users.push(normalizeRec('users',created.user));
   return jres({ok:true,id:created.id},201);
  }
 }
 if(parts[1]==='users'&&parts[2]&&method==='PATCH'){
  adminOnly();
  var uid=Number(parts[2]);
  await rpc('cerish_user_update',{p_token:getToken(),p_id:uid,p_data:body||{}});
  var target=db.users.filter(function(x){return Number(x.id)===uid})[0];
  if(target){
   if(body&&body.name!=null)target.name=String(body.name).trim();
   if(body&&body.role!=null)target.role=body.role;
   if(body&&body.active!=null)target.active=body.active?1:0;
  }
  return {ok:true};
 }
 if(parts[1]==='password'&&method==='POST'){
  currentUser();
  await rpc('cerish_password',{p_token:getToken(),p_current_password:body.current_password,p_new_password:body.new_password});
  return {ok:true};
 }

 if(parts[1]==='analytics'){
  var usr=currentUser();
  if(parts[2]==='summary'){
   var posted=db.videos.filter(function(v){return v.status==='Đã đăng'});
   var funnelOrder=['Tiềm năng','Đã liên hệ','Đang đàm phán','Đang hợp tác','Tạm dừng','Ngừng hợp tác'];
   var funnel=funnelOrder.map(function(s){return {label:s,value:db.partners.filter(function(p){return p.stage===s}).length}}).filter(function(f){return f.value>0});
   var tops=db.partners.map(function(p){
    var vids=posted.filter(function(v){return Number(v.partner_id)===Number(p.id)});
    return {id:p.id,name:p.name,handle:p.handle,gmv:vids.reduce(function(a,v){return a+(v.gmv||0)},0),orders:vids.reduce(function(a,v){return a+(v.orders||0)},0)};
   }).sort(function(a,b){return b.gmv-a.gmv}).slice(0,5);
   var upcoming=db.tasks.filter(function(t){return t.status!=='Hoàn thành'}).slice().sort(function(a,b){
    var ea=a.due_date===''?1:0,eb=b.due_date===''?1:0;
    if(ea!==eb)return ea-eb;
    return a.due_date<b.due_date?-1:a.due_date>b.due_date?1:0;
   }).slice(0,6).map(function(t){var p=byId('partners',t.partner_id)||{};return {id:t.id,title:t.title,due_date:t.due_date,priority:t.priority,status:t.status,partner_name:p.name||null}});
   var recent=db.audit_logs.slice().sort(function(a,b){return b.id-a.id}).slice(0,6).map(function(a){return {action:a.action,entity:a.entity,entity_id:a.entity_id,created_at:a.created_at}});
   return {
    partners:db.partners.length,
    active:db.partners.filter(function(p){return p.stage==='Đang hợp tác'}).length,
    booked:db.bookings.filter(function(b){return ['Đã hủy','Đề xuất'].indexOf(b.status)<0}).length,
    delivered:db.samples.filter(function(s){return s.status==='Đã nhận'}).length,
    videos:posted.length,
    video_gmv:posted.reduce(function(a,v){return a+(v.gmv||0)},0),
    live_gmv:db.lives.filter(function(l){return l.status==='Đã diễn ra'}).reduce(function(a,l){return a+(l.gmv||0)},0),
    tasks:db.tasks.filter(function(t){return t.status!=='Hoàn thành'}).length,
    overdue:db.tasks.filter(function(t){return t.status!=='Hoàn thành'&&t.due_date&&t.due_date<today()}).length,
    funnel:funnel,top_partners:tops,upcoming:upcoming,recent:recent
   };
  }
  if(parts[2]==='report'){
   var rows2=db.partners.map(function(p){
    var vids=db.videos.filter(function(v){return Number(v.partner_id)===Number(p.id)&&v.status==='Đã đăng'});
    var lvs=db.lives.filter(function(l){return Number(l.partner_id)===Number(p.id)&&l.status==='Đã diễn ra'});
    var vgmv=vids.reduce(function(a,v){return a+(v.gmv||0)},0);
    var lgmv=lvs.reduce(function(a,l){return a+(l.gmv||0)},0);
    return {id:p.id,name:p.name,handle:p.handle,stage:p.stage,commission:p.commission,
     samples_received:db.samples.filter(function(s){return Number(s.partner_id)===Number(p.id)&&s.status==='Đã nhận'}).length,
     videos_posted:vids.length,
     video_views:vids.reduce(function(a,v){return a+(v.views||0)},0),
     video_orders:vids.reduce(function(a,v){return a+(v.orders||0)},0),
     video_gmv:vgmv,live_gmv:lgmv,
     estimated_commission:Math.round((vgmv+lgmv)*p.commission/100)};
   }).sort(function(a,b){return b.video_gmv-a.video_gmv});
   return {rows:rows2};
  }
  if(parts[2]==='audit'){
   if(usr.role!=='admin')throw new HttpError(403,'Không có quyền');
   return {rows:db.audit_logs.slice().sort(function(a,b){return b.id-a.id}).slice(0,50).map(function(a){
    var au=db.users.filter(function(x){return Number(x.id)===Number(a.user_id)})[0];
    return Object.assign({},a,{user_name:au?au.name:null});
   })};
  }
 }

 if(parts[1]==='data'&&parts[2]){
  var table=parts[2];
  if(!TABLES[table])throw new HttpError(404,'Không tìm thấy phân hệ');
  if(!parts[3]){
   if(method==='GET')return listItems(table,q);
   if(method==='POST'){
    var user=currentUser();
    var data2=validate(table,body.data,false);
    checkVideoBooking(table,data2);
    checkPartner(data2);
    if(table==='partners')checkPartnerDuplicate(data2);
    if(table==='bookings'&&!Number(data2.campaign_id||0))throw new HttpError(422,'Booking mới phải thuộc một chiến dịch sản phẩm');
    checkCampaign(table,data2);
    if(table==='products'&&!String(data2.booking_owner||'').trim())throw new HttpError(422,'Mỗi sản phẩm phải có một nhân sự phụ trách booking');
    if(TABLES[table].indexOf('partner_id')>=0&&table!=='tasks'&&!data2.partner_id)throw new HttpError(422,'Vui lòng chọn đối tác');
    if(table==='samples'&&data2.status==='Đã nhận'&&!data2.received_date)data2.received_date=today();
    var stamp2=now();
    var rec={id:newId()};
    TABLES[table].forEach(function(f){rec[f]=(f in data2)?data2[f]:defaultFor(table,f)});
    rec.created_at=stamp2;rec.updated_at=stamp2;
    await putDoc(table,rec);
    db[table].push(rec);
    log(user,'create',table,rec.id);
    if(table==='samples'&&data2.status==='Đã nhận')await sampleFollowup(user,data2.partner_id,data2.owner||'');
    return jres({ok:true,id:rec.id},201);
   }
  } else {
   var rid=Number(parts[3]);
   if(method==='GET'){
    currentUser();
    var row=byId(table,rid);
    if(!row)throw new HttpError(404,'Không tìm thấy dữ liệu');
    var record=Object.assign({},row);
    if(table==='partners'){
     record.related={};
     ['bookings','samples','videos','lives','tasks'].forEach(function(child){
      record.related[child]=db[child].filter(function(c){return Number(c.partner_id)===rid}).sort(function(a,b){return b.id-a.id}).slice(0,8).map(function(c){return Object.assign({},c)});
     });
    }
    return record;
   }
   if(method==='PATCH'){
    var user3=currentUser();
    var data3=validate(table,body.data,true);
    var old=byId(table,rid);
    if(!old)throw new HttpError(404,'Không tìm thấy dữ liệu');
    checkVideoBooking(table,data3,old);
    checkPartner(data3);
    if(table==='partners'&&(('name' in data3)||('handle' in data3)))checkPartnerDuplicate(data3,rid);
    if(table==='bookings'&&('campaign_id' in data3)&&!Number(data3.campaign_id||0))throw new HttpError(422,'Không thể bỏ liên kết chiến dịch của booking');
    checkCampaign(table,data3);
    if(table==='products'&&('booking_owner' in data3)&&!String(data3.booking_owner||'').trim())throw new HttpError(422,'Mỗi sản phẩm phải có một nhân sự phụ trách booking');
    var wasReceived=table==='samples'&&data3.status==='Đã nhận'&&old.status!=='Đã nhận';
    if(wasReceived&&!data3.received_date&&!old.received_date)data3.received_date=today();
    var merged=Object.assign({},old,data3,{updated_at:now()});
    await putDoc(table,merged);
    db[table][db[table].indexOf(old)]=merged;
    if(table==='products'&&['booking_owner','name','sku'].some(function(k){return k in data3})){
     for(var ci=0;ci<db.campaigns.length;ci++){
      var c=db.campaigns[ci];
      if(Number(c.product_id)===rid){
       var c2=Object.assign({},c,{product:merged.name,sku:merged.sku,owner:merged.booking_owner,updated_at:now()});
       try{await putDoc('campaigns',c2);db.campaigns[ci]=c2}catch(e){}
      }
     }
    }
    log(user3,'update',table,rid,Object.keys(data3).join(','));
    if(wasReceived)await sampleFollowup(user3,data3.partner_id||merged.partner_id,merged.owner);
    return {ok:true,id:rid};
   }
   if(method==='DELETE'){
    var user4=currentUser();
    if(user4.role!=='admin')throw new HttpError(403,'Chỉ quản trị viên được xóa');
    if(!byId(table,rid))throw new HttpError(404,'Không tìm thấy dữ liệu');
    if(table==='products'&&db.campaigns.some(function(c){return Number(c.product_id)===rid}))throw new HttpError(409,'Sản phẩm đã có chiến dịch. Hãy chuyển trạng thái thay vì xóa.');
    if(table==='products'&&db.samples.some(function(s){return Number(s.product_id)===rid}))throw new HttpError(409,'Sản phẩm đã có lịch sử gửi mẫu. Hãy chuyển trạng thái thay vì xóa.');
    if(table==='bookings'&&db.videos.some(function(v){return Number(v.booking_id)===rid}))throw new HttpError(409,'Booking đã có video. Hãy lưu trữ hoặc chuyển video trước khi xóa.');
    if(table==='campaigns'&&db.bookings.some(function(b){return Number(b.campaign_id)===rid}))throw new HttpError(409,'Chiến dịch có booking liên quan. Hãy chuyển sang Tạm dừng/Hoàn thành.');
    if(table==='partners'){
     var hasChild=['bookings','samples','videos','lives','tasks'].some(function(child){return db[child].some(function(c){return Number(c.partner_id)===rid})});
     if(hasChild)throw new HttpError(409,'Đối tác có lịch sử hoạt động. Hãy chuyển trạng thái ngừng hợp tác thay vì xóa.');
    }
    await dropDoc(table,rid);
    db[table]=db[table].filter(function(r){return Number(r.id)!==rid});
    log(user4,'delete',table,rid);
    return {ok:true};
   }
  }
 }
 throw new HttpError(404,'Không tìm thấy phân hệ');
}
function defaultFor(table,f){
 if(f==='status')return STATUS[table]?STATUS[table][0]:'';
 if(f==='stage')return 'Tiềm năng';
 if(f==='type')return 'KOC';
 if(f==='platform')return 'TikTok';
 if(f==='channel')return 'TikTok Shop';
 if(f==='segment')return 'Mới';
 if(f==='priority')return 'Trung bình';
 if(f==='content_type')return 'Video';
 if(f==='video_status')return 'Chưa đăng';
 if(f==='live_status')return 'Chưa live';
 if(f==='quantity')return 1;
 if(f==='commission')return 8;
 if(f==='activity_mode')return 'Live';
 if(NUMERIC[f]||MONEY[f]||f==='campaign_id'||f==='product_id'||f==='booking_id')return 0;
 if(f==='partner_id')return null;
 return '';
}

window.fetch=function(input,opts){
 var path=typeof input==='string'?input:(input&&input.url)||'';
 if(path.indexOf('/api/')===0){
  return handle(path,opts||{}).then(function(out){
   return out instanceof Response?out:jres(out);
  },function(e){
   if(e instanceof HttpError)return jres({detail:e.detail},e.status);
   return jres({detail:'Lỗi hệ thống: '+(e&&e.message||e)},500);
  });
 }
 return realFetch(input,opts);
};

// Xuất CSV: trên web thường nên tải file trực tiếp.
window.demoExport=function(table){
 try{
  var cols=['id'].concat(TABLES[table]||[]).concat(['created_at','updated_at']);
  var lines=[cols.join(',')];
  (db[table]||[]).slice().sort(function(a,b){return b.id-a.id}).forEach(function(r){
   lines.push(cols.map(function(c){
    var v=r[c]==null?'':String(r[c]);
    if(/^[=+\-@]/.test(v.replace(/^\s+/,'')))v="'"+v;
    if(/[",\n]/.test(v))v='"'+v.replace(/"/g,'""')+'"';
    return v;
   }).join(','));
  });
  var blob=new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='CERISH_'+table+'.csv';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href)},5000);
 }catch(e){}
};

// Huy hiệu trạng thái
document.addEventListener('DOMContentLoaded',function(){
 var b=document.createElement('div');
 b.style.cssText='position:fixed;bottom:18px;left:18px;z-index:97;background:#fff;border:1px solid #e8dce4;border-radius:9px;box-shadow:0 8px 28px rgba(60,32,48,.12);padding:9px 13px;font:600 10.5px "Segoe UI",sans-serif;color:#8d7b88;display:flex;gap:8px;align-items:center';
 b.innerHTML='<span style="width:7px;height:7px;border-radius:50%;background:#3ecf8e;display:inline-block"></span>Dữ liệu đồng bộ Supabase · tải lại trang để thấy thay đổi của người khác';
 document.body.appendChild(b);
 if(!SB_URL||!SB_KEY){
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:98;display:grid;place-items:center;background:#f9f8f8;font:600 13px "Segoe UI",sans-serif;color:#6d425b;text-align:center;padding:20px';
  ov.innerHTML='<div style="max-width:430px"><div style="font-size:26px;margin-bottom:12px">⚙️</div>Web chưa được cấu hình Supabase.<br>Quản trị viên cần dán <b>Project URL</b> và <b>anon key</b> vào đầu tệp <b>crm/index.html</b>.</div>';
  document.body.appendChild(ov);
 }
});
})();
