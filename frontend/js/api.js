// Calls to our own backend (which in turn calls SCB).

async function getJson(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return resp.json();
}

export const fetchCatalog = () => getJson('/api/datasets');
export const fetchDataset = (id) => getJson(`/api/datasets/${encodeURIComponent(id)}`);
export const fetchGeo = (name) => getJson(`/data/${name}.geojson`);
