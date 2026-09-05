# 라벨체크 웹

한국 식품 표시·광고 규정(식품표시광고법, 식품등의 표시기준, 건강기능식품 표시기준, 부당한 표시·광고의 내용 기준) 원문 발췌 지식베이스와 Claude API로 제품 문구를 사전 점검하는 도구입니다.

## 구성

- `worker.js` — Cloudflare Worker. 화면 서빙 + 접속 코드 인증 + Claude API 스트리밍 중계
- `ui.html` — 검수 화면 (즉시 감지 규칙 + 이미지·PDF 업로드 + 실시간 결과 표시)
- `kb.js` — 규정 지식베이스 번들 (국가법령정보센터 수집본 112개 조문·항목)
- `wrangler.toml` — 배포 설정

## 배포

```
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY   # Claude API 키
npx wrangler secret put ACCESS_CODE         # 접속 코드
```

API 키와 접속 코드는 Cloudflare 비밀값으로만 저장되며 저장소에는 포함되지 않습니다.

## 주의

판정은 AI 추정이며 법적 효력이 없습니다. 최종 표시사항은 규정 원문과 담당자 검토로 확정하세요.
