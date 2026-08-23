/* Geolocalização.
 *
 * Realidade do terreno de 1000 m² (~30 x 33 m): o GPS do iPhone erra de 4 a 10
 * metros a céu aberto, e mais que isso debaixo de copa. Ou seja, a coordenada
 * NÃO distingue um canteiro do outro — assumir que distingue é o erro clássico
 * desse tipo de app. Aqui o GPS serve para duas coisas em que ele é bom:
 *   - dizer em que REGIÃO a planta está, para o filtro regional na identificação;
 *   - marcar o ponto de plantas que ficam fora do croqui (viagem, mudas doadas).
 * A localização fina dentro do terreno é resolvida pelo croqui + zona (canteiro).
 */

const OPCOES = { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 };

export function temGeo() {
  return 'geolocation' in navigator;
}

export function posicaoAtual() {
  if (!temGeo()) return Promise.reject(new Error('Este aparelho não expõe GPS ao navegador.'));
  return new Promise((ok, erro) => {
    navigator.geolocation.getCurrentPosition(
      (p) => ok({
        lat: +p.coords.latitude.toFixed(6),
        lon: +p.coords.longitude.toFixed(6),
        precisao: Math.round(p.coords.accuracy),
        em: new Date().toISOString(),
      }),
      (e) => erro(new Error(mensagemDeErro(e))),
      OPCOES,
    );
  });
}

function mensagemDeErro(e) {
  if (e.code === 1) return 'Permissão de localização negada. Ajustes › Safari › Localização.';
  if (e.code === 2) return 'Não consegui uma posição agora. Tente de novo a céu aberto.';
  if (e.code === 3) return 'O GPS demorou demais para responder.';
  return 'Falha ao obter a localização.';
}

export function formatarGps(gps) {
  if (!gps) return '';
  return `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} (±${gps.precisao} m)`;
}

export function linkMapa(gps) {
  if (!gps) return '';
  return `https://maps.apple.com/?ll=${gps.lat},${gps.lon}&q=Planta`;
}

/** Distância aproximada em metros (Haversine). */
export function distancia(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}
