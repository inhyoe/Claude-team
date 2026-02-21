# Claude Team

[Claude Code](https://claude.ai/claude-code)용 역할 기반 개발팀 시뮬레이션 플러그인.

범용 실행 에이전트 대신, Claude Team은 전문 역할(PM, PL, 프론트엔드, 백엔드, QA, 디자이너, DevOps, 보안, DBA)을 가진 **가상 개발팀**을 구성하여 구조화된 통신, 칸반 워크플로우, 품질 게이트를 통해 협업합니다.

## 주요 기능

- **9개 전문 역할**: 고유 페르소나, 전문 분야, AI 프로바이더 배정
- **DAG 기반 작업 오케스트레이션**: 위상 정렬 및 병렬 실행 레이어
- **칸반 파이프라인** (Backlog -> Todo -> In-Progress -> Review -> Done): 상태 머신 검증
- **품질 게이트**: 5차원 평가 (정확성, 보안, 성능, 유지보수성, 테스트 커버리지)
- **역할 병합**: 작업 복잡도에 따라 1-4개 에이전트로 스케일링
- **SQLite 영속성** (WAL 모드): 10개 테이블 스키마로 전체 상태 추적
- **구조화된 JSON 통신**: 역할 기반 송수신 권한
- **MCP 브릿지**: Claude Code에 팀 도구 노출

## 아키텍처

```
사용자: "/ct-team REST API 구축"
        |
        v
  [PM: 요구사항]  [PL: 아키텍처]          <- Layer 0 (기획)
        |                |
        +--- 품질 게이트 ---+
        |
  [BE Dev: API]  [FE Dev: 클라이언트]     <- Layer 1 (실행)
        |              |
        +--- 품질 게이트 ---+
        |
  [QA: 테스트]  [Security: 보안 감사]     <- Layer 2 (검증)
        |
        v
      완료
```

### Planner-Worker-Judge 패턴

멀티 에이전트 코딩 시스템 연구에서 영감을 받은 3계층 구조를 사용합니다:

| 계층 | 역할 | 책임 |
|------|------|------|
| **Planner** | PM, PL | 요구사항, 아키텍처, 작업 분해 |
| **Worker** | FE Dev, BE Dev, UI/UX, DevOps, DBA | 구현 |
| **Judge** | QA Engineer, Security Specialist | 리뷰, 품질 게이트 |

## 역할

| 역할 | 페르소나 | 모델 | 프로바이더 | 계층 |
|------|---------|------|----------|------|
| PM | Alex | opus | claude | Planner |
| PL | Jordan | opus | claude | Planner |
| FE Dev | Sam | sonnet | claude | Worker |
| BE Dev | Morgan | sonnet | claude | Worker |
| QA Engineer | Riley | sonnet | codex | Judge |
| UI/UX Designer | Taylor | sonnet | claude | Worker |
| DevOps | Casey | sonnet | codex | Worker |
| Security | Avery | opus | codex | Judge |
| DBA | Drew | sonnet | codex | Worker |

### AI 프로바이더 전략

시스템은 Claude와 Codex 이중 프로바이더 아키텍처를 사용하며, 작업 특성에 따라 역할을 배정합니다:

| 프로바이더 | 역할 | 근거 |
|-----------|------|------|
| **Claude** | PM, PL, FE Dev, BE Dev, UI/UX Designer | 반복적 도구 사용, 팀 메시징, 다중 턴 협업 |
| **Codex** | QA Engineer, Security, DevOps, DBA | 원샷 분석/리뷰, 비용 효율적, 구조화된 평가에 강점 |

**왜 Judge에 Codex를 사용하는가?** Codex는 독립적이고 단일 패스로 수행하는 구조화된 코드 리뷰와 보안 분석 작업에 뛰어납니다. 이러한 분리는 편향 없는 리뷰 관점도 제공합니다 — 리뷰어가 구현자와 다른 모델을 사용하기 때문입니다.

**폴백:** Codex를 사용할 수 없는 경우 Claude sonnet으로 대체하여 파이프라인 연속성을 유지합니다.

### 역할 병합

작은 작업의 경우 오버헤드를 줄이기 위해 역할을 병합합니다:

| 복잡도 | 에이전트 수 | 구성 |
|--------|-----------|------|
| Tiny (< 0.2) | 1 | PL이 모든 역할 흡수 |
| Small (0.2-0.4) | 2 | PM+PL 병합, Worker 1명 |
| Medium (0.4-0.7) | 3 | PM, PL+Worker, QA |
| Large (0.7-1.0) | 4 | PM, PL, Workers, QA+Security |

병합 규칙: 동일 DAG 레이어만 가능, 동일 AI 프로바이더만 가능, 양방향 호환성 필수.

## 칸반 파이프라인

```
Backlog -> Todo -> In-Progress -> Review -> Done
  ^          ^          ^           |
  |          |          +-----------+  (리뷰 거부)
  |          +--- Blocked ---+
  +--- Failed (재시도 가능) --+
```

각 전이는 역할 기반 권한을 가진 상태 머신으로 검증됩니다:
- **PM/PL**: 모든 전이에 대한 전체 접근 권한
- **Worker**: 자신의 작업만 전진 가능 (todo -> in-progress -> review)
- **Judge**: 승인 (review -> done) 또는 거부 (review -> in-progress)

## 품질 게이트

1-10점 척도의 5차원 평가:

| 차원 | 가중치 |
|------|--------|
| 정확성 (Correctness) | 표준 |
| 보안 (Security) | 표준 |
| 성능 (Performance) | 표준 |
| 유지보수성 (Maintainability) | 표준 |
| 테스트 커버리지 (Test Coverage) | 표준 |

**판정:**

| 점수 | 판정 | 조치 |
|------|------|------|
| >= 7.0 (모든 차원 >= 3) | Pass | Done으로 이동 |
| 5.0 - 6.9 | Conditional | 상위 모델로 재리뷰 |
| 3.0 - 4.9 | Reject | In-Progress로 반환 + 피드백 |
| < 3.0 | Auto-reject | PL에게 에스컬레이션 |

게이트당 최대 3회 리뷰. 소진 시 PL이 판단: 재시도, 작업 분할, 재설계, 또는 위험 수용.

### 가중 리뷰 집계

여러 리뷰어가 동일 작업을 평가할 때:
- Security Specialist: 1.5배 가중치
- QA Engineer: 1.3배 가중치
- PL: 1.2배 가중치
- 기타 역할: 1.0배 가중치

## 설치

```bash
# 저장소 클론
git clone https://github.com/ryu/claude-team.git
cd claude-team

# 의존성 설치
npm install

# 빌드
npm run build
```

### 요구사항

- Node.js >= 20.0.0
- Claude Code CLI
- `better-sqlite3` (자동 설치)

## 사용법

### 스킬

| 스킬 | 설명 |
|------|------|
| `/ct-team` | 메인 팀 오케스트레이션 - 역할 기반 에이전트로 분해 및 실행 |
| `/ct-sprint` | 스프린트 관리 - 계획, 추적, 리뷰 |
| `/ct-kanban` | 칸반 보드 - 작업 상태 조회 및 관리 |
| `/ct-review` | 품질 게이트 리뷰 - 리뷰 트리거 및 결과 조회 |
| `/ct-setup` | 플러그인 설정 및 구성 |

### 예시

```bash
# 팀 세션 시작
/ct-team "JWT 토큰을 사용한 사용자 인증 시스템 구축"

# 칸반 보드 조회
/ct-kanban

# 품질 리뷰 트리거
/ct-review task-1

# 스프린트 관리
/ct-sprint plan
```

## 워크플로우: 전체 과정 예시

Claude Team이 실제 작업을 처음부터 끝까지 처리하는 과정입니다.

### 시나리오: `"인증 기능이 포함된 사용자 관리 REST API 구축"`

#### 0단계: 복잡도 분석

```
/ct-team "인증 기능이 포함된 사용자 관리 REST API 구축"
```

복잡도 분석기가 평가:
- 파일 수: ~12개 (라우트, 컨트롤러, 미들웨어, 모델, 테스트)
- 모듈 간 의존성: 4개 (인증 ↔ 사용자 ↔ DB ↔ 미들웨어)
- API 변경: 있음
- 보안 관련: 있음 (인증, 비밀번호 해싱)
- DB 변경: 있음 (사용자 테이블)

→ **점수: 0.75 (Large)** → 4개 에이전트 활성화

#### 1단계: team-plan — 기획 (Layer 0)

**활성 에이전트:**

| 에이전트 | 역할 | 프로바이더 | 수행 작업 |
|---------|------|----------|---------|
| Alex (PM) | Planner | Claude opus | 유저 스토리, 수용 기준이 포함된 PRD 작성 |
| Jordan (PL) | Planner | Claude opus | 아키텍처 설계, 작업별 파일 소유권 할당 |

**PM (Alex) 산출물:**
```
.omc/artifacts/sprint-1/prd.md
├── 유저 스토리: 회원가입, 로그인, 토큰 갱신, 로그아웃
├── 스토리별 수용 기준
└── 우선순위: 로그인 > 회원가입 > 토큰 > 로그아웃
```

**PL (Jordan) 산출물:**
```
.omc/artifacts/sprint-1/architecture.md
├── 파일 소유권 맵:
│   ├── BE Dev: src/routes/, src/controllers/, src/models/
│   ├── FE Dev: (이 작업에서는 불필요)
│   ├── DBA: src/db/migrations/, src/db/schema.ts
│   └── Security: src/middleware/auth.ts (리뷰만)
├── DAG 실행 계획 (4개 레이어)
└── 공유 파일 중재 계획
```

**칸반 보드:**
```
| Backlog   | Todo       | In-Progress | Review | Done |
|-----------|------------|-------------|--------|------|
| task-1    |            |             |        |      |
| task-2    |            |             |        |      |
| task-3    |            |             |        |      |
| task-4    |            |             |        |      |
```

→ **품질 게이트**: PL이 기획 산출물을 승인한 후 실행 단계로 진행

#### 2단계: team-exec — 실행 (Layer 1-2)

**활성 에이전트:**

| 에이전트 | 역할 | 프로바이더 | 할당된 작업 |
|---------|------|----------|-----------|
| Morgan (BE Dev) | Worker | Claude sonnet | task-1: 사용자 모델 + CRUD API |
| Drew (DBA) | Worker | Codex | task-2: DB 마이그레이션 + 스키마 |

파일 소유권 격리 하에 병렬 실행:

```
Morgan (Claude sonnet):               Drew (Codex):
├── src/models/user.ts                ├── src/db/migrations/001_users.ts
├── src/routes/auth.ts                ├── src/db/schema.ts
├── src/controllers/auth.ts           └── src/db/seed.ts
└── src/middleware/jwt.ts
```

**칸반 보드 진행:**
```
| Backlog | Todo   | In-Progress     | Review | Done |
|---------|--------|-----------------|--------|------|
| task-3  |        | task-1 (Morgan) |        |      |
| task-4  |        | task-2 (Drew)   |        |      |
```

각 워커가 완료되면 자신의 작업을 Review로 이동:
```
| Backlog | Todo   | In-Progress | Review           | Done |
|---------|--------|-------------|------------------|------|
| task-3  |        |             | task-1 (Morgan)  |      |
| task-4  |        |             | task-2 (Drew)    |      |
```

#### 3단계: team-verify — 품질 리뷰 (Layer 3)

**활성 에이전트:**

| 에이전트 | 역할 | 프로바이더 | 리뷰 유형 |
|---------|------|----------|---------|
| Riley (QA) | Judge | Codex | 코드 리뷰 + 테스트 커버리지 |
| Avery (Security) | Judge | Codex | 보안 감사 |

Codex가 diff와 변경 파일 목록을 받아 구조화된 JSON 점수를 생성:

**Riley (QA, Codex 경유) task-1 리뷰:**
```json
{
  "correctness": 8,
  "security": 6,
  "performance": 7,
  "maintainability": 8,
  "testCoverage": 4,
  "feedback": "인증 컨트롤러 단위 테스트 누락. JWT 만료 엣지 케이스 미처리."
}
```
→ 평균: 6.6 → **CONDITIONAL** (테스트 커버리지 부족)

**Avery (Security, Codex 경유) task-1 리뷰:**
```json
{
  "correctness": 7,
  "security": 5,
  "performance": 7,
  "maintainability": 7,
  "testCoverage": 5,
  "feedback": "비밀번호가 bcrypt로 해싱되지 않음. JWT 시크릿이 소스에 하드코딩."
}
```

**가중 집계** (Security 1.5배, QA 1.3배):
```
보안 차원:       (6×1.3 + 5×1.5) / 2.8 = 5.5
테스트 커버리지: (4×1.3 + 5×1.5) / 2.8 = 4.5
종합:           5.5 → CONDITIONAL
```

→ task-1이 통합 피드백과 함께 **team-fix**로 반환

#### 4단계: team-fix — 재작업 (루프)

Morgan (BE Dev)이 통합 피드백을 수신:
1. bcrypt 비밀번호 해싱 추가
2. JWT 시크릿을 환경 변수로 이동
3. 인증 컨트롤러 단위 테스트 작성
4. JWT 만료 엣지 케이스 처리

```
| Backlog | Todo   | In-Progress     | Review | Done         |
|---------|--------|-----------------|--------|--------------|
| task-3  |        | task-1 (Morgan) |        | task-2       |
| task-4  |        |                 |        |              |
```

수정 후 task-1이 다시 Review로 → **재리뷰 (시도 2/3)**:

**Riley (QA, Codex 경유) 재리뷰:**
```json
{
  "correctness": 9,
  "security": 8,
  "performance": 7,
  "maintainability": 8,
  "testCoverage": 7,
  "feedback": "테스트 커버리지 양호. 모든 엣지 케이스 처리 완료."
}
```
→ 평균: 7.8 → **PASS**

```
| Backlog | Todo   | In-Progress | Review | Done              |
|---------|--------|-------------|--------|-------------------|
|         | task-3 |             |        | task-1, task-2    |
|         | task-4 |             |        |                   |
```

#### 5단계: 나머지 작업 + 완료

task 3-4도 동일한 사이클을 거침 (실행 → 검증 → 필요 시 수정 → 완료).

**최종 보드:**
```
| Backlog | Todo | In-Progress | Review | Done                          |
|---------|------|-------------|--------|-------------------------------|
|         |      |             |        | task-1, task-2, task-3, task-4|
```

**스프린트 속도**: 4/4 작업 × (평균 점수 7.6/10) = **76%**

---

### 복잡도별 워크플로우

| 복잡도 | 에이전트 | 대표 시나리오 | 흐름 |
|--------|---------|-------------|------|
| **Tiny** (1개) | PL이 전체 흡수 | "README 오타 수정" | PL이 기획+실행+자체리뷰 → 완료 |
| **Small** (2개) | Lead + Worker | "사용자 목록에 페이지네이션 추가" | Lead 기획 → Worker 구현 → Lead 리뷰 → 완료 |
| **Medium** (3개) | PM + Lead+Worker + QA | "필터가 포함된 검색 기능 추가" | PM 범위 정의 → Lead+Worker 구현 → QA(Codex) 리뷰 → 완료 |
| **Large** (4개) | PM + PL + Dev + QA+Security | "인증 시스템 구축" | 위 예시와 같은 전체 DAG 파이프라인 |

### 실행 중 스킬 명령어

파이프라인 실행 중 상호작용할 수 있습니다:

```bash
# 진행 상황 모니터링
/ct-kanban                        # 현재 보드 상태 조회

# 수동 개입
/ct-kanban move task-2 blocked    # 작업 차단 (예: 외부 의존성 대기)
/ct-kanban assign task-3 fe-dev   # 다른 역할에 작업 재할당

# 특정 리뷰 트리거
/ct-review task-1                 # 전체 품질 게이트 리뷰 실행
/ct-review task-1 --type security # 보안 중심 리뷰만 실행

# 스프린트 관리
/ct-sprint status                 # 스프린트 진행률 및 속도 확인
/ct-sprint complete               # 스프린트 완료 표시
```

### 에스컬레이션 시나리오

| 상황 | 처리 방법 |
|------|---------|
| 리뷰 3회 실패 | PL (Jordan)이 판단: 재시도, 작업 분할, 재설계, 또는 위험 수용 |
| 워커 10분간 무응답 | PL이 다른 가용 워커에게 작업 재할당 |
| 공유 파일 충돌 | PL이 직렬화하여 중재 — 분산 락킹 없음 |
| Codex 사용 불가 | 리뷰 작업에 대해 자동으로 Claude sonnet으로 폴백 |
| 수정 루프 한도 초과 | 파이프라인이 `failed` 상태로 전이, PL이 `team-plan`에서 재시작 가능 |

## 프로젝트 구조

```
claude-team/
├── agents/               # 9개 역할 에이전트 프롬프트 + 공유 프리앰블
├── bridge/               # MCP 브릿지 서버 (ct-bridge.cjs)
├── hooks/                # 파이프라인 및 품질 게이트 훅
├── skills/               # 사용자 호출 가능 스킬 정의
├── src/
│   ├── agents/           # 역할 정의, 병합기, 페르소나
│   ├── communication/    # 프로토콜, 메시지 버스, 산출물 교환
│   ├── core/             # DAG 엔진, 복잡도 분석기, PWJ
│   ├── features/         # 상태 관리자, 작업 분해기, 위임
│   ├── kanban/           # 상태 머신, 보드 조작
│   ├── persistence/      # SQLite DB, 7개 리포지토리 모듈
│   ├── quality/          # 게이트, 리뷰 스코어러, 에스컬레이션
│   ├── shared/           # 타입, 상수
│   └── team/             # 팀 등록, 작업 라우터
└── tests/
    ├── unit/             # 9개 테스트 스위트, 220개 테스트
    └── integration/      # SQLite 영속성 파이프라인, 36개 테스트
```

## 데이터베이스 스키마

WAL 모드의 SQLite. `{project}/.omc/state/claude-team.db`에 10개 테이블 저장:

| 테이블 | 용도 |
|--------|------|
| `schema_info` | 버전 추적 |
| `projects` | 프로젝트 설정 |
| `roles` | 역할 할당 및 병합 상태 |
| `tasks` | 파일 소유권이 있는 칸반 항목 |
| `kanban_history` | 상태 전이 감사 추적 |
| `communication_log` | 역할 간 메시지 로그 |
| `artifacts` | 생성된 산출물 (PRD, 설계서, 보고서) |
| `sprints` | 스프린트 계획 및 속도 |
| `dag_nodes` | 실행 계획 노드 |
| `quality_gates` | 리뷰 점수 및 판정 |

## 테스트

```bash
# 전체 테스트 실행
npm run test:run

# 워치 모드로 실행
npm test

# 특정 스위트 실행
npx vitest run tests/unit/dag-engine.test.ts

# 통합 테스트만 실행
npx vitest run tests/integration/
```

**테스트 커버리지:**
- 9개 단위 테스트 스위트: DAG 엔진, 칸반 상태 머신, 역할 병합기, 품질 스코어링, 통신 프로토콜, 에스컬레이션, 리뷰 스코어러, 복잡도 분석기, 상태 관리자
- 1개 통합 테스트 스위트: 전체 SQLite 영속성 파이프라인 (DB 라이프사이클, CRUD, 칸반 플로우, 품질 게이트, 트랜잭션, E2E 스프린트 사이클)
- **총 256개 테스트**

## 통신 프로토콜

타입이 지정된 JSON 페이로드를 사용하는 7가지 메시지 유형:

| 유형 | 송신 | 수신 | 채널 |
|------|------|------|------|
| `task_assignment` | PM/PL | Workers | DM |
| `status_report` | Workers | PM/PL | DM |
| `review_request` | Workers | QA/Security | DM + Artifact |
| `review_result` | QA/Security | PL | DM |
| `escalation` | 모든 역할 | PM/PL | DM |
| `artifact_handoff` | 생산자 | 소비자 | Artifact |
| `gate_result` | QA/Security | PL | DM |

## 설계 참고 자료

- Planner-Worker-Judge 계층 구조 (Cursor의 flat agent 실패 모드 회피)
- 최대 3-4개 동시 에이전트 (5개 이상 시 조율 오버헤드 증가)
- DAG 기반 동적 레이어 구성 (Google ADK, AWS Strands 패턴)
- 구조화된 JSON 스키마 통신 (2026 에이전틱 코딩 트렌드)
- Codex 리뷰어를 활용한 품질 게이트 (AI PR 67.3% 거부율 대응)

## 라이선스

MIT
