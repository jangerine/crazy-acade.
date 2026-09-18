# 💦 크아 온라인 (KEUA ONLINE)

크레이지아케이드 스타일의 실시간 멀티플레이어 물풍선 대전 게임입니다.
Node.js + Express + Socket.io로 만들어졌고, 별도 빌드 과정 없이 바로 Render에 배포할 수 있습니다.

## 게임 규칙 (요약)
- 방을 만들고 코드를 공유해서 최대 4명까지 함께 플레이합니다.
- 방향키(또는 WASD)로 이동, 스페이스바로 물풍선을 설치합니다.
- 물풍선은 3초 뒤 터지며, 범위 안에 있으면 상대는 물풍선에 **갇힙니다**.
- 갇힌 플레이어는 아군이 터치하면 풀려나고, 9초 안에 구출되지 못하거나
  다시 폭발에 맞으면 **탈락**합니다.
- 벽을 부수면 아이템(물풍선 수 +1 / 사거리 +1 / 이동속도 +)이 나올 수 있습니다.
- 마지막까지 살아남는 플레이어가 승리합니다.

## 로컬에서 실행하기
```bash
npm install
npm start
```
브라우저에서 http://localhost:3000 접속 (여러 탭/기기로 접속하면 같이 플레이할 수 있습니다).

---

## 1. GitHub에 올리기

```bash
cd keua-game
git init
git add .
git commit -m "init: keua online multiplayer game"
git branch -M main
git remote add origin https://github.com/<내-계정>/<저장소이름>.git
git push -u origin main
```

> GitHub에서 새 저장소를 먼저 만든 뒤(Public 또는 Private 상관없음),
> 위 `<내-계정>/<저장소이름>` 부분을 본인 정보로 바꿔주세요.

## 2. Render에 배포하기

### 방법 A: render.yaml 사용 (Blueprint)
1. [render.com](https://render.com) 가입 후 로그인
2. Dashboard → **New** → **Blueprint**
3. 방금 만든 GitHub 저장소를 선택 (Render가 저장소 안의 `render.yaml`을 자동 인식)
4. 그대로 **Apply** 누르면 빌드 및 배포가 시작됩니다.

### 방법 B: 수동 설정 (Web Service)
1. Dashboard → **New** → **Web Service**
2. GitHub 저장소 연결 (처음이면 GitHub 계정 연동 필요)
3. 아래처럼 입력:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (테스트용) 또는 원하는 플랜
4. **Create Web Service** 클릭 → 몇 분 뒤 `https://your-app.onrender.com` 형태의 주소가 발급됩니다.

### 배포 후 확인
- 발급받은 주소로 접속해서 방을 만들고, 다른 사람에게 같은 주소 + 방 코드를 공유하면
  실시간으로 함께 플레이할 수 있습니다.
- Render 무료 플랜은 일정 시간 트래픽이 없으면 서버가 슬립 모드로 들어가서
  첫 접속 시 로딩이 몇 십 초 걸릴 수 있습니다. (유료 플랜으로 올리면 상시 구동)

### 코드 수정 후 재배포
```bash
git add .
git commit -m "update: 수정 내용"
git push
```
GitHub에 push하면 Render가 자동으로 감지해서 다시 빌드/배포합니다 (Auto-Deploy 기본 활성화).

---

## 프로젝트 구조
```
keua-game/
├── server.js         # 서버 (룸 관리, 게임 루프, 물풍선/충돌 로직)
├── package.json
├── render.yaml        # Render Blueprint 설정
├── public/
│   ├── index.html     # 로비 / 게임 / 결과 화면 마크업
│   ├── style.css       # 아케이드풍 UI 스타일
│   └── client.js       # 소켓 통신, 입력 처리, 캔버스 렌더링
└── README.md
```

## 커스터마이징 아이디어
- `server.js`의 `TICK_MS`, `BUBBLE_TIMER`, `TRAP_TIMEOUT`, `ITEM_DROP_CHANCE` 값을 조절해 밸런스 변경
- `PLAYER_COLORS` / `PLAYER_NAMES_EMOJI` 배열로 캐릭터 색상·아이콘 커스터마이징
- `createMap()` 함수를 수정해 다양한 맵 레이아웃 추가
- 팀전(2:2) 모드를 추가하려면 `checkWinCondition`과 `popBubble`의 판정 로직에 팀 아이디를 반영하면 됩니다

즐거운 게임 되세요! 🎮
