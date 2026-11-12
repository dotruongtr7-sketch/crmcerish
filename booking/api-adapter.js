/* Optional integration bridge for CERISH CRM V15/V16-style endpoints.
 * It is not loaded by the standalone preview. Use within your authenticated CRM.
 * It uses the browser's existing same-origin session cookie.
 */
window.CERISH_BOOKING_API = {
  async request(url, options={}) {
    const response=await fetch(url,{
      credentials:'same-origin',
      ...options,
      headers:{'Content-Type':'application/json',...(options.headers||{})}
    });
    let body;
    try { body=await response.json(); } catch { body={}; }
    if(!response.ok) throw new Error(body.detail||`HTTP ${response.status}`);
    return body;
  },
  async list(table) {
    const rows=[];let page=1,total=1;
    while(rows.length<total&&page<=100){
      const result=await this.request(`/api/data/${table}?per_page=1000&page=${page}`);
      rows.push(...(result.rows||[]));total=Number(result.total||rows.length);page++;
      if(!result.rows?.length)break;
    }
    return rows;
  },
  async create(table,data){return this.request(`/api/data/${table}`,{method:'POST',body:JSON.stringify({data})});},
  async update(table,id,data){return this.request(`/api/data/${table}/${id}`,{method:'PATCH',body:JSON.stringify({data})});},
  async remove(table,id){return this.request(`/api/data/${table}/${id}`,{method:'DELETE'});}
};
