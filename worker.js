// 식품 표시·광고 규정 검수 웹서비스 - Cloudflare Worker (규정 지식베이스 + Claude API 스트리밍)
import { INDEX, CHUNKS } from "./kb.js";
import { EXPORT_CHUNKS } from "./exportkb.js";
import UI_HTML from "./ui.html";
import GUIDE_HTML from "./guide.html";
import EVAL_HTML from "./eval.html";
import RULES_JS from "./rules.lib.txt";

// 위치 고정 중계기 - Anthropic 미지원 경유지(홍콩 등) 차단을 피하기 위해
// 미국 동부에 상주하는 Durable Object가 업스트림 호출을 대신 수행한다
export class Relay {
  constructor(state, env) { this.env = env; }
  async fetch(request) {
    const target = request.headers.get("X-Relay-Target");
    if (!target || !target.startsWith("https://gateway.ai.cloudflare.com/") && !target.startsWith("https://api.anthropic.com/")) {
      return new Response("bad target", { status: 400 });
    }
    const headers = new Headers();
    for (const h of ["x-api-key", "anthropic-version", "content-type"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    return fetch(target, { method: "POST", headers, body: request.body });
  }
}

async function relayFetch(env, target, headers, body) {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay-v1"), { locationHint: "enam" });
  return stub.fetch("https://relay/", {
    method: "POST",
    headers: { ...headers, "X-Relay-Target": target },
    body,
  });
}

const BASE_IDS = ["L1-8", "L1-8_2", "L4-2-1", "L4-2-2", "L4-2-3", "L4-2-4", "C-case"];
const HFF_BASE = ["C-hff1", "C-hff2", "L3-4", "L3-5-1"];

// 키워드가 몇 개 청크에 등장하는지 집계 - 흔한 키워드는 변별력이 낮으므로 점수를 낮춘다
let KW_DF = null;
function kwDf() {
  if (KW_DF) return KW_DF;
  KW_DF = {};
  for (const it of INDEX.items || []) for (const k of new Set(it.kw || [])) KW_DF[k] = (KW_DF[k] || 0) + 1;
  return KW_DF;
}

function pickChunks(text, ptype) {
  const df = kwDf();
  const n = (INDEX.items || []).length || 1;
  const scored = [];
  for (const it of INDEX.items || []) {
    let s = 0;
    for (const k of it.kw || []) {
      if (k && text.includes(k)) s += 1 + Math.log(1 + n / (df[k] || 1));
    }
    if (BASE_IDS.includes(it.id)) s += 3;
    if (ptype === "건강기능식품") {
      if (HFF_BASE.includes(it.id)) s += 3;
      if (it.id.startsWith("L3")) s += 1;
    }
    if (s > 0) scored.push([s, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 9).map((x) => x[1]);
}

function buildPrompt(ptype, text, pdftext, picked, hasImages, suggest, compose) {
  let ref = "";
  const budget = 14000;
  for (const it of picked) {
    const c = CHUNKS[it.id];
    if (!c) continue;
    const piece = "[" + (c.kind === "요약" ? "요약: " : "원문: ") + c.title + "]\n" + c.text + "\n\n";
    if (ref.length + piece.length < budget) ref += piece;
  }
  if (compose) {
    return [
      "너는 한국 식품 표시사항(라벨) 문안 작성 전문가다. 아래 [규정 자료]를 근거로, 제공된 자료(품목제조보고서·제품 정보·이미지)에서 확인되는 정보로 패키지에 인쇄할 표시사항 문안 초안을 작성하라.",
      "",
      "제품 유형: " + ptype,
      "",
      ref ? "[규정 자료]\n" + ref : "",
      "[제공된 제품 정보]",
      text.slice(0, 5000),
      pdftext ? pdftext.slice(0, 6000) : "",
      hasImages ? "\n(첨부된 이미지·PDF의 내용도 정보로 활용하라)" : "",
      "",
      "[출력 형식 - 반드시 이 마크다운 구조로]",
      "## 표시사항 문안 초안",
      "(일괄표시면 형식으로: 제품명 / 식품유형 / 내용량 / 원재료명 / 소비기한 / 보관방법 / 포장재질 / 품목보고번호 / 제조원 / 판매원 / 섭취방법 등. 자료에 없는 값은 [확인 필요: 무엇]으로 표시)",
      "## 의무 문구",
      "(부정·불량식품 신고 1399, 소비자분쟁해결기준 교환·보상 문구, 반품·교환처 등 이 제품에 필요한 것)",
      "## 확인 필요 항목",
      "- 자료로 확정할 수 없어 담당자 확인이 필요한 항목과 그 이유",
      "## 사용 금지·주의 표현",
      "- 이 제품 유형에서 쓰면 위반이 되는 표현 (제공된 광고 문구가 있으면 그것도 판정)",
      "## 다음 단계",
      "(인쇄 전 확인 1~3개)",
      "",
      "그리고 응답 맨 끝에, 엑셀 파일 생성용 데이터를 아래 형식 그대로 출력하라. 설명 없이, 코드 블록(```)으로 감싸지 말고, 각 블록은 반드시 [/EXCEL]로 닫아라.",
      "[EXCEL:표기사항]",
      "구분|항목|내용|비고",
      "(행 예시: 주표시면|제품명|키즈픽션|22P 권장 / 정보표시면|식품유형|캔디류|10P / 문구|주의사항|① ...② ...|10P. 정보표시면에는 제품명·식품유형·내용량·품목보고번호·원재료명 및 함량·알레르기 표시·섭취량 및 섭취방법·내포장재질·소비기한·고객상담실·제조원·판매원 등 이 제품에 필요한 항목을 모두 넣고, 주의사항·보관방법 문구도 행으로 넣어라. 영양성분 자료가 있으면 영양정보 행들도 넣어라. 확인 불가한 값은 [확인 필요: 무엇]으로.)",
      "[/EXCEL]",
      "[EXCEL:배합비율]",
      "번호|원재료명 또는 성분명|배합비율(%)",
      "(자료에 배합비율표가 있으면 전 행을 그대로. 없으면 이 블록 전체를 생략하라.)",
      "[/EXCEL]",
      "",
      "[규칙] 규정 자료에 있는 내용은 그 조문을 근거로 하라. 자료에 없는 값을 지어내지 말고 [확인 필요]로 남겨라. 입력에 없는 제품 사실(원산지·첨가물·함량·인증 등)을 새로 추가하지 말라. 식품유형은 자료(품목제조보고서)에 적힌 값을 한 글자도 바꾸지 말고 그대로 쓰고, 새로 분류·추측하지 말라. 제품 유형에 따라 영양성분 표시 의무 여부를 판단해 언급하라.",
    ].join("\n");
  }
  const parts = [
    "너는 한국 식품 표시·광고 규정 검수 전문가다. 아래 [규정 자료]의 원문·요약을 최우선 근거로 삼아 제품 문구를 검수하라.",
    "",
    "제품 유형: " + ptype,
    "",
    ref ? "[규정 자료 - 이 발췌를 근거로 인용하라]\n" + ref : "",
    "[검수 대상 문구]",
    text.slice(0, 5000),
    pdftext ? pdftext.slice(0, 6000) : "",
    hasImages ? "\n(첨부된 패키지 이미지·PDF 페이지의 문구와 표시면도 함께 검수하라)" : "",
    "",
    "[출력 형식 - 반드시 이 마크다운 구조로]",
    "## 종합 판정",
    "(한두 문장. 전체 위험 수준)",
    "## 위반 위험 문구",
    '- [높음] "문구" — 위반 사유. 근거: (규정 자료의 해당 조문·항목 인용, 요약 자료면 \'요약 기준\' 명시). 수정 제안: ~',
    "- [중간]/[낮음] 같은 형식. 위험 문구가 없으면 '발견된 위험 문구 없음'",
    "(위험도 기준: [높음]은 규정을 명백히 어긴 경우에만 쓴다. 규정에 맞는지 더 확인해봐야 하는 사항, 실물을 봐야 아는 사항은 여기 쓰지 말고 아래 '확인 필요 사항'에 쓴다. "
      + "건강기능식품이 고시·인정된 기능성 문구를 그대로 표시한 경우는 위반이 아니므로 여기에 쓰지 말라.)",
    "(반드시 확인할 광고 표현: '무(無)방부제·무보존료·무색소·무MSG' 같은 무첨가 강조 표시는, 그 식품유형에 원래 사용할 수 없거나 통상 쓰지 않는 원료를 쓰지 않았다고 강조하는 것이어서 "
      + "다른 제품이 열등한 것처럼 오인시키는 부당한 표시·광고에 해당한다(부당광고 기준 제2조3호 사목). '금지 사항이 아니다'라고 판단하지 말고 위험으로 지적하라. "
      + "'100%', '천연', '무설탕'도 조건을 충족해야만 쓸 수 있으므로 근거 확인을 요구하라.)",
    "## 확인 필요 사항",
    "- 위반은 아니지만 담당자가 확인해야 하는 항목 (복합원재료 세부 구성, 실물 표시 여부, 근거자료 보유 여부 등). 없으면 '없음'",
    "## 누락 의심 필수 표시사항",
    "- 항목명 — 제공된 내용에서 확인되지 않음 (실물에 있다면 무시)",
    "(다음을 반드시 하나씩 확인해서 해당되면 지적하라: "
      + "① 제품명에 원재료명·성분명을 사용하거나 강조한 경우 그 원재료의 함량(%)을 표시했는지 "
      + "② 소비기한을 '제조일로부터 ○개월'처럼 기간으로만 적었는지 — 이 경우 포장에는 '별도 표기일까지'처럼 실제 날짜를 가리키는 형식으로 써야 한다 "
      + "③ 알레르기 유발물질이 원재료에 있는데 '○○ 함유' 표시가 없는지 "
      + "④ 부정·불량식품 신고 1399 문구, 소비자상담 연락처, 보관방법, 업소명·소재지가 있는지)",
    "## 오타·표기 오류",
    '- "잘못된 표기" → "올바른 표기" — 이유',
    "(다음을 모두 점검하라: ① 원재료명·식품첨가물 명칭이 공전·고시상 정식 명칭과 다른 경우(예: 글리세린지방산에스테르, 소르빈산칼륨 등의 오기) ② 알레르기 유발물질 표시, 보관방법, '부정·불량식품 신고는 국번없이 1399' 등 정형 문구의 오타 ③ 일반 한글 맞춤법·띄어쓰기 오류. 공전상 명칭 여부가 확실하지 않으면 '확인 필요'를 붙여라. 없으면 '발견된 오타 없음')",
    suggest
      ? "## 수정 문안 제안\n" +
        '- 원래: "문구" → 제안: "규정에 맞게 고친 문구" (한 줄 이유)\n' +
        "(위반·위험 문구마다 위 형식으로. 원래 표현의 마케팅 의도는 최대한 살리되 규정을 지키는 문구로 바꿔라. 규정상 살릴 방법이 없는 문구는 '삭제 권고'라고 써라.)\n" +
        "### 전체 수정본\n" +
        "(광고 문구 전체를 위 제안이 모두 반영된 완성 문안으로 다시 써서 한 단락으로 제시하라. 표시사항 항목(제품명·원재료명 등)은 고치지 말고 광고·홍보 문구만 다시 써라. "
        + "입력에 없는 제품 사실(원산지·첨가물 유무·함량·인증 등)을 새로 추가하거나 사실처럼 단정하지 말라. 확인되지 않은 것은 문안에 넣지 말라.)"
      : "",
    "## 다음 단계",
    "(가장 시급한 수정 1~3개)",
    "",
    "[규칙] 규정 자료에 있는 내용은 그 조문·항목을 근거로 정확히 인용하라. 자료에 없는 사항은 일반 지식으로 판단하되 '자료 외 판단(원문 확인 필요)'을 붙여라. 조항 번호를 지어내지 말라.",
    "[중요] 규정에 부합하는 표시를 위반으로 판정하지 말라. 특히 건강기능식품이 고시·인정된 기능성 문구(예: 프로바이오틱스의 '유산균 증식 및 유해균 억제에 도움을 줄 수 있음')를 그대로 표시한 경우는 적합이며 위반 위험 문구에 넣지 말라. "
      + "'원문에서 재확인이 필요하다'는 정도의 사유로 [높음]을 붙이지 말라 - 그런 항목은 '확인 필요 사항'에 쓴다. 문제가 없으면 없다고 분명히 말하라.",
  ];
  return parts.join("\n");
}

function buildExportPrompt(country, text, pdftext, hasImages, suggest) {
  const chunks = EXPORT_CHUNKS[country] || [];
  const ref = chunks.map((c) => "[참고: " + c.title + "]\n" + c.text).join("\n\n");
  const nation = country === "수출(미국)" ? "미국(FDA)" : "일본(식품표시기준)";
  const lang = country === "수출(미국)" ? "영어" : "일본어";
  const parts = [
    "너는 한국 식품의 " + nation + " 수출용 표시(라벨) 사전 점검 전문가다. 아래 [참고 자료]와 너의 지식을 근거로, 이 제품을 " + nation + " 시장에 수출한다고 가정하고 라벨 문구를 검수하라.",
    "",
    "[참고 자료 - 핵심 요약이며 규정 원문이 아니다. 원문 확인이 필요한 판단에는 반드시 '원문 확인 필요'를 붙여라]",
    ref,
    "",
    "[검수 대상 문구 - 한국어 라벨이거나 현지어 초안일 수 있다]",
    text.slice(0, 5000),
    pdftext ? pdftext.slice(0, 6000) : "",
    hasImages ? "\n(첨부된 패키지 이미지·PDF 페이지의 문구와 표시면도 함께 검수하라)" : "",
    "",
    "[출력 형식 - 반드시 이 마크다운 구조로]",
    "## 종합 판정",
    "(한두 문장. " + nation + " 기준 위험 수준과 가장 큰 문제)",
    "## 부적합·위험 표시",
    '- [높음] "문구" — ' + nation + " 기준 위반·부적합 사유. 근거: (참고 자료 또는 일반 지식, 지식이면 '원문 확인 필요' 병기). 수정 방향: ~",
    "- [중간]/[낮음] 같은 형식. 한국 라벨을 그대로 쓸 수 없는 항목(알레르겐 목록 차이, 영양성분표 형식 차이 등)도 여기서 짚어라.",
    "## 누락 의심 필수 표시사항",
    "- " + nation + " 필수 항목 중 제공된 내용에서 확인되지 않는 것 (실물에 있다면 무시)",
    "## 오타·표기 오류",
    "- " + lang + " 표기의 철자·용어 오류, 잘못된 현지 명칭 (제공된 문구에 현지어가 없으면 '현지어 문안 없음 — 번역 라벨 작성 필요'라고 써라)",
    suggest
      ? "## 수정 문안 제안\n- 항목별로 " + lang + " 표시 문안 예시를 제안하라 (예: 알레르겐 문장, 내용량 표기, 원산국 표기). 제공된 광고 문구가 있으면 현지 규제에 맞는 " + lang + " 대체 문구도 제안하라.\n### 현지 라벨 표시 초안\n(필수 표시사항을 " + lang + "로 정리한 일괄 표시 초안을 제시하라. 확인 불가한 항목은 [확인 필요]로 남겨라.)"
      : "",
    "## 다음 단계",
    "(수출 전 반드시 해야 할 확인 1~3개 - 예: 현지 수입자 검토, 첨가물 허용 여부 확인)",
    "",
    "[규칙] 참고 자료는 요약이므로 세부 수치·조항은 단정하지 말고 '원문 확인 필요'를 붙여라. 조항 번호를 지어내지 말라. 입력에 없는 제품 사실(원산지·첨가물·함량·인증 등)을 새로 추가하지 말고 확인 불가 항목은 [확인 필요]로 남겨라. 이 검수는 참고용 사전 점검이며 최종 라벨은 현지 수입자와 전문가 검토로 확정해야 함을 다음 단계에서 상기시켜라.",
  ];
  return parts.join("\n");
}

function buildExcelPrompt(text, pdftext, hasImages) {
  return [
    "너는 한국 식품 패키지 한글표기사항 정리 전문가다. 아래 자료(품목제조보고서·영양 검사성적서·제품 정보)에서 값을 추출해, 컬러박스 인쇄용 한글표기사항 데이터를 작성하라.",
    "",
    "[자료]",
    text.slice(0, 6000),
    pdftext ? pdftext.slice(0, 12000) : "",
    hasImages ? "(첨부된 이미지·PDF 페이지의 내용을 자료로 읽어서 사용하라)" : "",
    "",
    "[핵심 규칙 - 반드시 지켜라]",
    "1. 식품유형(식품의 유형)은 자료에 적힌 값을 한 글자도 바꾸지 말고 그대로 옮겨라. 예를 들어 자료가 '기타가공품'이면 정확히 '기타가공품'이다. 제품 성격을 보고 유형을 새로 분류·추측하는 것을 절대 금지한다. 자료에서 못 찾으면 [확인 필요: 식품유형]으로 써라.",
    "2. 자료에 없는 값은 지어내지 말고 [확인 필요: 무엇]으로 써라. 입력에 없는 제품 사실(원산지·함량·인증마크)을 새로 추가하지 말라.",
    "3. 원재료명 및 함량은 배합비율이 높은 순서대로 쓰고, 복합원재료(기타가공품[○○] 등)는 대괄호 안 명칭을 사용하라. 복합원재료의 세부 구성 원재료가 자료에 없으면 절대 추측해서 풀어 쓰지 말고 명칭 뒤에 [구성 확인 필요]를 붙여라. 알레르기 유발물질(우유·대두·밀 등 법정 목록)이 원재료에 있으면 알레르기 행에 '○○ 함유' 형식으로 써라.",
    "5. 배합비율 표는 행을 요약·생략하지 말고 자료에 있는 모든 행을 빠짐없이 그대로 옮겨라(자료가 26행이면 출력도 26행). 품목제조보고번호(요청 번호 포함)는 자릿수까지 정확히 옮겨라.",
    "4. 소비기한이 기간형(제조일로부터 ○개월)이면 내용은 '별도 표기일까지 (제조일로부터 ○개월)'로 써라.",
    "",
    "[출력 형식 - 아래 구조만 출력하라. 코드블록(```) 금지, 각 블록은 반드시 [/EXCEL]로 닫아라]",
    "## 확인 필요 항목",
    "- (자료로 확정하지 못한 항목과 이유. 없으면 '없음')",
    "",
    "[EXCEL:표기사항]",
    "구분|항목|내용|비고",
    "주표시면|제품명|(값)|22P",
    "주표시면|식품의 유형|(자료 그대로)|",
    "주표시면|내용량|(값, 예: 150g(10g*15포))|10P",
    "주표시면|주원료 및 함량|(주표시면 강조용 주원료 요약. 확정 불가면 [확인 필요])|14P",
    "정보표시면|제품명|(값)|10P",
    "정보표시면|식품유형|(자료 그대로)|10P",
    "정보표시면|내용량|(값)|10P",
    "정보표시면|품목보고번호|(값)|10P",
    "정보표시면|원재료명 및 함량|(전체 원재료. 함량 의무 대상은 %병기)|10P",
    "정보표시면|알레르기|(예: 우유, 대두 함유 - 해당 없으면 이 행 생략)|10P 굵게",
    "정보표시면|섭취량 및 섭취방법|(값)|10P",
    "정보표시면|내포장재질|(값)|10P",
    "정보표시면|소비기한|(값)|10P",
    "정보표시면|고객상담실|(값 또는 [확인 필요])|10P",
    "정보표시면|제조원|(업소명 / 주소)|10P",
    "정보표시면|유통전문판매원|(값 또는 [확인 필요])|10P",
    "(영양 검사성적서가 있으면 여기에 영양정보|항목|값 행들을 추가: 영양정보|열량|○kcal 형식, 100g당인지 1회분량당인지 명시)",
    "주의사항|①|(문구: 특이체질·알레르기 체질은 원재료 확인 등)|",
    "주의사항|②|(문구: 부정·불량식품 신고는 국번없이 1399 포함)|",
    "보관방법|①|(문구)|",
    "보관방법|②|(문구)|",
    "[/EXCEL]",
    "",
    "[EXCEL:배합비율]",
    "번호|원재료명 또는 성분명|배합비율(%)",
    "(자료의 배합비율 전체를 순서대로. 없으면 이 블록 생략)",
    "[/EXCEL]",
  ].join("\n");
}

// 카카오 '나에게 보내기' - KV에 저장된 토큰으로 전송, 만료 시 자동 갱신
async function sendKakao(env, text) {
  try {
    const raw = await env.HIST.get("kakao:tokens");
    if (!raw || !env.KAKAO_REST_KEY) return false;
    let tok = JSON.parse(raw);
    const doSend = async (accessToken) => {
      const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/x-www-form-urlencoded" },
        body: "template_object=" + encodeURIComponent(JSON.stringify({
          object_type: "text", text: text.slice(0, 900),
          link: { web_url: "https://labelcheck.dkmdkm999.workers.dev" },
          button_title: "라벨체크 열기",
        })),
      });
      return r.status;
    };
    let status = await doSend(tok.a);
    if (status === 401) {
      const tr = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&client_id=" + env.KAKAO_REST_KEY + (env.KAKAO_CLIENT_SECRET ? "&client_secret=" + env.KAKAO_CLIENT_SECRET : "") + "&refresh_token=" + tok.r,
      });
      const nt = await tr.json();
      if (nt.access_token) {
        tok = { a: nt.access_token, r: nt.refresh_token || tok.r, t: Date.now() };
        await env.HIST.put("kakao:tokens", JSON.stringify(tok));
        status = await doSend(tok.a);
      }
    }
    return status === 200;
  } catch (e) { return false; }
}

// 일일 AI 호출 상한 - 접속 코드 유출 시 비용 폭주 방지 (KV 특성상 근사치)
async function checkQuota(env) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const uk = "u:" + day;
  const cnt = parseInt((await env.HIST.get(uk)) || "0", 10);
  if (cnt >= 150) return json({ error: "quota", message: "오늘 AI 사용 한도(150회)에 도달했습니다. 내일 다시 이용해주세요." }, 429);
  await env.HIST.put(uk, String(cnt + 1), { expirationTtl: 172800 });
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const code = request.headers.get("X-Access-Code") || "";
  return !!env.ACCESS_CODE && code === env.ACCESS_CODE;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    if (request.method === "GET" && url.pathname === "/guide") {
      return new Response(GUIDE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // 정확도 측정 페이지 (관리자용) - 화면 진입은 열려 있고 실제 측정은 접속 코드가 필요하다
    if (request.method === "GET" && url.pathname === "/eval") {
      return new Response(EVAL_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // 규칙 판정 로직 - 화면과 정확도 측정이 같은 파일을 쓴다
    if (request.method === "GET" && url.pathname === "/rules.js") {
      return new Response(RULES_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // 측정 회차 기록 - 고친 뒤 점수가 올랐는지 비교하기 위해 남긴다
    if (url.pathname === "/api/evalrun" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const at = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const id = "e:" + String(1e13 - Date.now()).padStart(13, "0");
      const rec = {
        at,
        all: typeof body.all === "number" ? body.all : null,
        rule: typeof body.rule === "number" ? body.rule : null,
        ai: typeof body.ai === "number" ? body.ai : null,
        total: Number(body.total) || 0,
        passed: Number(body.passed) || 0,
        fails: (Array.isArray(body.fails) ? body.fails : []).map((x) => String(x).slice(0, 12)).slice(0, 40),
      };
      await env.HIST.put(id, JSON.stringify(rec));
      const list = await env.HIST.list({ prefix: "e:", limit: 100 });
      for (let i = 30; i < list.keys.length; i++) await env.HIST.delete(list.keys[i].name);
      return json({ ok: true });
    }
    if (url.pathname === "/api/evalruns" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const list = await env.HIST.list({ prefix: "e:", limit: 30 });
      const items = [];
      for (const k of list.keys) {
        const v = await env.HIST.get(k.name);
        if (v) { try { items.push(JSON.parse(v)); } catch (e) {} }
      }
      return json({ items });
    }

    if (request.method === "POST" && url.pathname === "/api/auth") {
      return json({ ok: authorized(request, env) }, authorized(request, env) ? 200 : 401);
    }

    if (request.method === "GET" && url.pathname === "/api/diag") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const up = await relayFetch(env,
        "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
        { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
      let detail = "";
      try { detail = (await up.text()).slice(0, 120); } catch (e) {}
      return json({ colo: request.cf && request.cf.colo, upstream: up.status, detail });
    }

    // 식품안전나라 공공데이터 조회 - 품목보고번호/제품명/바코드 (AI 미사용, 무료)
    if (url.pathname === "/api/lookup" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      if (!env.FSK_KEY) return json({ error: "no_fsk_key", message: "식품안전나라 인증키가 설정되지 않았습니다." }, 500);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const kind = String(body.kind || "report").slice(0, 10);
      const q = String(body.q || "").trim().slice(0, 60);
      if (!q) return json({ error: "empty", message: "조회할 값을 입력해주세요." }, 400);
      const fsk = async (svc, param, range) => {
        // 동일 조회는 하루 캐시 - 정부 API 시간당 100회 제한 보호 + 응답 속도 개선
        const ck = "fsk:" + svc + ":" + (param || "all");
        const hit = await env.HIST.get(ck);
        if (hit) { try { return JSON.parse(hit); } catch (e) {} }
        const res = await fetch("https://openapi.foodsafetykorea.go.kr/api/" + String(env.FSK_KEY).trim() + "/" + svc + "/json/" + (range || "1/10") + (param ? "/" + param : ""));
        const txt = await res.text();
        let data; try { data = JSON.parse(txt); } catch (e) { return { rows: [], total: "0", err: txt.slice(0, 150) }; }
        const b = data[svc] || {};
        const out = { rows: b.row || [], total: b.total_count || "0", code: b.RESULT ? b.RESULT.CODE : "" };
        if (out.rows.length || out.code === "INFO-200") {
          await env.HIST.put(ck, JSON.stringify(out), { expirationTtl: param ? 86400 : 21600 });
        }
        return out;
      };
      // 필터 파라미터가 없는 API는 전체를 받아 서버에서 직접 거른다
      const filterRows = (rows, q, fields) => rows.filter((r) => fields.some((f) => String(r[f] || "").includes(q))).slice(0, 10);
      try {
        if ((kind === "recall" || kind === "penalty") && q.length < 2) {
          return json({ error: "short", message: "두 글자 이상 입력해주세요." }, 400);
        }
        if (kind === "recall") {
          const all = await fsk("I0490", "", "1/1000");
          const rows = filterRows(all.rows, q, ["PRDTNM", "BSSHNM", "PRDLST_REPORT_NO", "BRCDNO", "LCNS_NO"]);
          return json({ main: rows, total: String(rows.length), src: "회수·판매중지 정보 (유통 중 " + all.total + "건)", code: all.code || "" });
        }
        if (kind === "penalty") {
          const all = await fsk("I0480", "", "1/1000");
          const rows = filterRows(all.rows, q, ["PRCSCITYPOINT_BSSHNM", "LCNS_NO", "VILTCN"]);
          return json({ main: rows, total: String(rows.length), src: "행정처분 결과 (식품제조가공업)", code: all.code || "" });
        }
        if (kind === "report") {
          // 식품 → 축산물 → 건기식 순으로 품목보고번호 조회
          let main = await fsk("I1250", "PRDLST_REPORT_NO=" + encodeURIComponent(q));
          let src = "식품(첨가물)품목제조보고";
          if (!main.rows.length) { main = await fsk("I1310", "PRDLST_REPORT_NO=" + encodeURIComponent(q)); src = "축산물 품목제조정보"; }
          if (!main.rows.length) { main = await fsk("I0030", "PRDLST_REPORT_NO=" + encodeURIComponent(q)); src = "건강기능식품 품목제조신고"; }
          const mat = main.rows.length ? await fsk("C002", "PRDLST_REPORT_NO=" + encodeURIComponent(q)) : { rows: [] };
          return json({ main: main.rows, materials: mat.rows, total: main.total, src: main.rows.length ? src : "", code: main.code || "", err: main.err || "" });
        }
        if (kind === "name") {
          const main = await fsk("I1250", "PRDLST_NM=" + encodeURIComponent(q));
          return json({ main: main.rows, total: main.total, src: "식품(첨가물)품목제조보고", code: main.code || "" });
        }
        if (kind === "barcode") {
          const main = await fsk("C005", "BAR_CD=" + encodeURIComponent(q));
          return json({ main: main.rows, total: main.total, src: "바코드연계제품정보", code: main.code || "" });
        }
        return json({ error: "bad_kind" }, 400);
      } catch (e) {
        return json({ error: "fsk_fail", message: "식품안전나라 조회 실패: " + String(e).slice(0, 120) }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      return json({
        kb: Object.keys(CHUNKS).length,
        updated: INDEX.updated || "",
        model: env.MODEL || "claude-haiku-4-5",
      });
    }

    // 공유 검수 이력 (Cloudflare KV) - 접속 코드 인증자 전원이 공유
    if (url.pathname === "/api/hist" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const list = await env.HIST.list({ prefix: "h:", limit: 30 });
      const items = [];
      for (const k of list.keys) {
        const m = k.metadata || {};
        items.push({ id: k.name, d: m.d || "", n: m.n || "", p: m.p || "" });
      }
      return json({ items });
    }
    if (url.pathname === "/api/hist" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const now = new Date();
      const d = now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      // 키를 역순 타임스탬프로 만들어 목록이 최신순이 되게 한다
      const id = "h:" + String(1e13 - Date.now()).padStart(13, "0") + Math.random().toString(36).slice(2, 6);
      const rec = { d, n: String(body.n || "").slice(0, 40), p: String(body.p || "").slice(0, 20), input: String(body.input || "").slice(0, 8000), r: String(body.r || "").slice(0, 30000) };
      await env.HIST.put(id, JSON.stringify(rec), { metadata: { d: rec.d, n: rec.n, p: rec.p } });
      // 100건 초과분 정리
      const list = await env.HIST.list({ prefix: "h:", limit: 200 });
      for (let i = 100; i < list.keys.length; i++) await env.HIST.delete(list.keys[i].name);
      return json({ ok: true, id });
    }
    if (url.pathname.startsWith("/api/hist/") && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const histId = decodeURIComponent(url.pathname.slice("/api/hist/".length));
      if (!histId.startsWith("h:")) return json({ error: "bad_id" }, 400);
      const rec = await env.HIST.get(histId);
      if (!rec) return json({ error: "not_found" }, 404);
      return new Response(rec, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/api/hist/") && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const histDelId = decodeURIComponent(url.pathname.slice("/api/hist/".length));
      if (!histDelId.startsWith("h:")) return json({ error: "bad_id" }, 400);
      await env.HIST.delete(histDelId);
      return json({ ok: true });
    }

    // OCR - 첨부 이미지 속 문구를 그대로 옮겨 적어 반환 (클로드 비전 사용)
    if (request.method === "POST" && url.pathname === "/api/ocr") {
      if (!authorized(request, env)) return json({ error: "auth", message: "접속 코드가 올바르지 않습니다." }, 401);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key" }, 500);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const images = (Array.isArray(body.images) ? body.images : []).filter(function (x) { return typeof x === "string"; }).slice(0, 14);
      if (!images.length) return json({ error: "no_image", message: "이미지가 없습니다." }, 400);
      const quota = await checkQuota(env);
      if (quota) return quota;
      const content = [];
      for (const durl of images) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(durl);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      content.push({ type: "text", text: "이것은 한국 식품 패키지·라벨 또는 식품 관련 서류(품목제조보고서·성적서 등)의 사진이다. 보이는 모든 한국어 문구를 위에서 아래, 왼쪽에서 오른쪽 순서로 글자 그대로 옮겨 적어라(전사). 규칙: ① 제품명·회사명 같은 고유명사는 아는 단어로 바꾸지 말고 보이는 글자를 한 글자씩 정확히 옮겨라 ② 표시사항 항목(제품명, 원재료명 등)이 구분되면 항목별로 줄을 나눠라 ③ 흐릿해서 확신이 없는 글자는 최선의 판독을 적되 바로 뒤에 (?)를 붙여라 ④ 표는 행 단위로 | 로 구분해 옮겨라. 설명·해석·머리말 없이 옮겨 적은 텍스트만 출력하라." });
      // 글자 판독은 정밀 모델(소네트) 사용 - 한국어 고유명사 오독 방지
      const upstream = await relayFetch(env,
        "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
        { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        JSON.stringify({ model: env.PRECISE_MODEL || "claude-sonnet-5", max_tokens: 3000, messages: [{ role: "user", content }] }));
      if (!upstream.ok) {
        const status = upstream.status;
        let detail = "";
        try { detail = (await upstream.text()).slice(0, 200); } catch (e) {}
        if (status === 403 && detail.includes("forbidden")) return json({ error: "region_retry", message: "경유지 문제 - 재시도 필요" }, 503);
        return json({ error: "api", message: "글자 읽기 실패 (" + status + "). 잠시 후 다시 시도하세요." }, 502);
      }
      const res = await upstream.json();
      const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return json({ text });
    }

    // ===== 카카오톡 알림 (나에게 보내기) =====
    // 최초 1회: /api/kakao/start 에서 카카오 로그인 동의 → 토큰을 KV에 저장
    if (url.pathname === "/api/kakao/start" && request.method === "GET") {
      if (!env.KAKAO_REST_KEY) return json({ error: "no_kakao_key" }, 500);
      if (url.searchParams.get("key") !== env.ACCESS_CODE) return new Response("접속 코드가 필요합니다: /api/kakao/start?key=접속코드", { status: 401 });
      const state = crypto.randomUUID();
      await env.HIST.put("s:" + state, "1", { expirationTtl: 600 });
      const redirect = url.origin + "/api/kakao/callback";
      const auth = "https://kauth.kakao.com/oauth/authorize?client_id=" + env.KAKAO_REST_KEY +
        "&redirect_uri=" + encodeURIComponent(redirect) + "&response_type=code&scope=talk_message&state=" + state;
      return Response.redirect(auth, 302);
    }
    if (url.pathname === "/api/kakao/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("인증 코드가 없습니다", { status: 400 });
      const st = url.searchParams.get("state");
      if (!st || !(await env.HIST.get("s:" + st))) return new Response("잘못된 인증 요청입니다 (state 불일치)", { status: 403 });
      await env.HIST.delete("s:" + st);
      const redirect = url.origin + "/api/kakao/callback";
      const tr = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&client_id=" + env.KAKAO_REST_KEY + (env.KAKAO_CLIENT_SECRET ? "&client_secret=" + env.KAKAO_CLIENT_SECRET : "") +
          "&redirect_uri=" + encodeURIComponent(redirect) + "&code=" + code,
      });
      const tok = await tr.json();
      if (!tok.access_token) return new Response("카카오 토큰 발급 실패: " + JSON.stringify(tok).slice(0, 200), { status: 500 });
      await env.HIST.put("kakao:tokens", JSON.stringify({ a: tok.access_token, r: tok.refresh_token, t: Date.now() }));
      return new Response("<meta charset='utf-8'><h2>✅ 카카오톡 알림 연결 완료</h2><p>이제 문의가 오면 카카오톡 '나와의 채팅'으로 알림이 갑니다. 이 창은 닫아도 됩니다.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ===== 문의하기 =====
    if (url.pathname === "/api/inquiry" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const by = String(body.by || "익명").slice(0, 20);
      const msg = String(body.msg || "").trim().slice(0, 1000);
      if (!msg) return json({ error: "empty" }, 400);
      const u = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const id = "i:" + String(1e13 - Date.now());
      await env.HIST.put(id, JSON.stringify({ by, msg, u }), { metadata: { by, u } });
      const sent = await sendKakao(env, "📩 라벨체크 문의\n보낸사람: " + by + " (" + u + ")\n\n" + msg);
      return json({ ok: true, kakao: sent });
    }
    if (url.pathname === "/api/inquiries" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const list = await env.HIST.list({ prefix: "i:", limit: 30 });
      const items = [];
      for (const k of list.keys) {
        const v = await env.HIST.get(k.name);
        if (v) items.push({ id: k.name, ...JSON.parse(v) });
      }
      return json({ items });
    }

    if (url.pathname.startsWith("/api/inquiry/") && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const inqId = decodeURIComponent(url.pathname.slice("/api/inquiry/".length));
      if (!inqId.startsWith("i:")) return json({ error: "bad_id" }, 400);
      await env.HIST.delete(inqId);
      return json({ ok: true });
    }

    // 공유 작업 문안(드래프트) - 같은 접속 코드 사용자끼리 함께 보고 수정
    if (url.pathname === "/api/drafts" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const list = await env.HIST.list({ prefix: "d:", limit: 50 });
      return json({ items: list.keys.map((k) => ({ id: k.name, n: (k.metadata || {}).n || "", u: (k.metadata || {}).u || "", by: (k.metadata || {}).by || "" })) });
    }
    if (url.pathname === "/api/draft" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const name = String(body.n || "").trim().slice(0, 50);
      if (!name) return json({ error: "no_name", message: "문안 이름이 필요합니다." }, 400);
      const id = "d:" + name;
      const u = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const rec = { n: name, text: String(body.text || "").slice(0, 20000), p: String(body.p || "일반식품").slice(0, 20), by: String(body.by || "").slice(0, 20), u };
      await env.HIST.put(id, JSON.stringify(rec), { metadata: { n: rec.n, u: rec.u, by: rec.by } });
      return json({ ok: true, id, u });
    }
    if (url.pathname.startsWith("/api/draft/") && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const draftId = decodeURIComponent(url.pathname.slice("/api/draft/".length));
      if (!draftId.startsWith("d:")) return json({ error: "bad_id" }, 400);
      const rec = await env.HIST.get(draftId);
      if (!rec) return json({ error: "not_found" }, 404);
      return new Response(rec, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/api/draft/") && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const draftDelId = decodeURIComponent(url.pathname.slice("/api/draft/".length));
      if (!draftDelId.startsWith("d:")) return json({ error: "bad_id" }, 400);
      await env.HIST.delete(draftDelId);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      if (!authorized(request, env)) return json({ error: "auth", message: "접속 코드가 올바르지 않습니다." }, 401);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key", message: "서버에 API 키가 설정되지 않았습니다." }, 500);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad_request" }, 400);
      }
      const ptype = String(body.ptype || "일반식품").slice(0, 20);
      const text = String(body.text || "");
      const pdftext = String(body.pdftext || "");
      const images = (Array.isArray(body.images) ? body.images : []).filter(function (x) { return typeof x === "string"; }).slice(0, 14);
      if (!text.trim() && !pdftext.trim() && !images.length) return json({ error: "empty", message: "검수할 문구나 이미지가 없습니다." }, 400);
      const quota = await checkQuota(env);
      if (quota) return quota;
      const suggest = !!body.suggest;
      const compose = !!body.compose;
      const excelOnly = body.mode === "excel";
      const isExport = !excelOnly && !!EXPORT_CHUNKS[ptype];
      const picked = (isExport || excelOnly) ? [] : pickChunks(text + " " + pdftext + " " + ptype + (compose ? " 표시 원재료명 소비기한 내용량" : ""), ptype);
      // 엑셀 모드에서 문서만 첨부된 경우: 정밀 모델로 먼저 전문 판독(OCR)한 뒤 그 텍스트를 자료로 합친다
      let ocrDoc = "";
      if (excelOnly && images.length && (text.length + pdftext.length) < 400) {
        const ocrContent = [];
        for (const durl of images) {
          const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(durl);
          if (m) ocrContent.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
        }
        ocrContent.push({ type: "text", text: "이것은 한국 식품 관련 서류(품목제조보고서·검사성적서 등)다. 보이는 모든 문구·표를 글자 그대로 빠짐없이 옮겨 적어라. 표는 행마다 | 로 구분하고 어떤 행도 생략하지 말라. 고유명사는 아는 단어로 바꾸지 말라. 설명 없이 전사 텍스트만 출력하라." });
        try {
          const ores = await relayFetch(env,
            "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
            { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            JSON.stringify({ model: env.PRECISE_MODEL || "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: ocrContent }] }));
          if (ores.ok) {
            const oj = await ores.json();
            ocrDoc = (oj.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
          }
        } catch (e) {}
      }
      const prompt = excelOnly
        ? buildExcelPrompt(text, (pdftext + (ocrDoc ? "\n[문서 정밀 판독 텍스트]\n" + ocrDoc : "")).slice(0, 12000), images.length > 0)
        : isExport
        ? buildExportPrompt(ptype, text, pdftext, images.length > 0, suggest)
        : buildPrompt(ptype, text, pdftext, picked, images.length > 0, suggest, compose);

      const content = [];
      for (const durl of images) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(durl);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      content.push({ type: "text", text: prompt });

      const model = body.precise ? (env.PRECISE_MODEL || "claude-sonnet-5") : (env.MODEL || "claude-haiku-4-5");
      // 위치 고정 중계기(미국 동부) 경유 - 홍콩 등 미지원 경유지의 403 차단 회피
      const upstream = await relayFetch(env,
        "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
        {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        JSON.stringify({
          model,
          max_tokens: (compose || excelOnly) ? 6000 : (suggest ? 4000 : 3000),
          stream: true,
          messages: [{ role: "user", content }],
        }));

      if (!upstream.ok) {
        const status = upstream.status;
        let detail = "";
        try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
        // 홍콩 등 미지원 경유지에서 실행된 경우 - 클라이언트가 재요청하면 경유지가 바뀐다
        if (status === 403 && detail.includes("forbidden")) {
          return json({ error: "region_retry", message: "해외 경유지 문제 - 자동 재시도 중입니다." }, 503);
        }
        let msg = "API 오류 (" + status + "). 잠시 후 다시 시도하세요." + (detail ? " [" + detail + "]" : "");
        if (status === 401) msg = "서버의 API 키가 올바르지 않습니다. 관리자에게 문의하세요.";
        if (status === 429) msg = "요청이 많거나 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.";
        if (status === 529) msg = "AI 서버가 혼잡합니다. 잠시 후 다시 시도하세요.";
        return json({ error: "api", message: msg }, 502);
      }

      // 참조 조문 목록을 첫 줄(JSON)로 보내고, 이어서 업스트림 SSE를 그대로 통과시킨다
      const refs = isExport
        ? (EXPORT_CHUNKS[ptype] || []).map((c) => ({ title: c.title, kind: c.kind }))
        : picked
            .map((it) => {
              const c = CHUNKS[it.id];
              return c ? { title: c.title, kind: c.kind || "원문" } : null;
            })
            .filter(Boolean);
      const header = new TextEncoder().encode("META:" + JSON.stringify({ refs, model, ocr: excelOnly ? ocrDoc.length : undefined }) + "\n");
      const upstreamReader = upstream.body.getReader();
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(header);
        },
        async pull(controller) {
          const { done, value } = await upstreamReader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          upstreamReader.cancel().catch(() => {});
        },
      });
      return new Response(readable, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
