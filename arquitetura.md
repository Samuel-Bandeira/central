# Arquitetura — Launcher de projetos multiabas

> **Nota de versão**: este documento substitui a exploração anterior
> (máquina remota + worktrees + SSH + Tailscale + board-agent + MCP). Aquela
> ideia resolvia um problema mais ambicioso (disparar execução de tarefas),
> mas o objetivo real era reduzir fricção no dia a dia — então pivotamos pra
> algo bem mais simples: um launcher de projetos local, com um resumo rápido
> do Trello e atalhos pro que você já usa (VS Code, o board de verdade).

## Visão geral

Um app local, de uma aba só no navegador, com um sistema de abas _interno_:

- **Aba Projetos** (fixa, não fecha) — lista todos os projetos cadastrados,
  cria novos, mostra um resumo rápido do Trello de cada um, um indicativo de
  se está **rodando** agora (via launchd, ver seção 8), e tem atalhos pra
  abrir no VS Code
- **Aba de detalhe** (dinâmica, uma por projeto aberto) — mostra as
  pastas do projeto (frontend/backend/infra, quando houver mais de uma),
  botões individuais de "abrir no VS Code", o resumo do Trello mais
  detalhado, e um botão "abrir no Trello" que leva pro board de verdade

Não existe kanban reconstruído dentro do app. O Trello **não permite** ser
embutido de forma interativa em outra página (só um preview não-interativo,
via a política de segurança deles) — então a decisão foi: usar a API só pra
leitura de contagens/resumo, e mandar você pro Trello de verdade quando quiser
editar algo.

---

## Componentes

### 1. `projects.json` (fonte de verdade dos projetos)

```json
{
  "id": "proj-123",
  "name": "App Principal",
  "folders": [
    { "name": "frontend", "path": "/Users/voce/code/app-frontend" },
    { "name": "backend", "path": "/Users/voce/code/app-backend" },
    { "name": "infra", "path": "/Users/voce/code/app-infra" }
  ],
  "trelloBoardUrl": "https://trello.com/b/aBcD1234/app-principal",
  "trelloBoardId": "aBcD1234"
}
```

`trelloBoardId` é extraído automaticamente da URL quando você cadastra o
projeto (é o trecho depois de `/b/`) — você só cola o link, não precisa saber
o que é o ID.

### 2. Servidor local (Node)

Serve o app e faz três coisas:

- Lê/grava `projects.json` (criar projeto, editar pastas, etc.)
- Faz _proxy_ das chamadas de leitura pro Trello — busca as listas e conta
  quantos cards tem em cada uma, pra montar o resumo. A key/token do Trello
  ficam só no servidor, nunca no navegador.
- Endpoints:
  - `GET /projects` — lista projetos com o resumo já embutido
  - `POST /projects` — cria projeto novo
  - `GET /projects/:id/trello-summary` — contagem de cards por lista
    (cacheável por alguns minutos, não precisa ser em tempo real)

### 3. Trello REST API (só leitura, dois níveis)

- **Resumo** — `GET /1/boards/:id/lists` + contagem de cards por lista, pra
  aba Projetos (cacheável, não precisa ser em tempo real)
- **Lista de cards** — título + status de cada card de um board, buscado
  quando a aba de detalhe é aberta, pra você ver e escolher qual atividade
  abrir/mover. Isso não é um kanban completo — é uma lista simples,
  suficiente pros botões "abrir com Claude" e "mover pra outra lista"

A única escrita nessa API é mover um card de lista (seção 6). Comentar,
anexar arquivo, editar descrição — isso continua sendo feito no Trello de
verdade (seção 5), não replicado aqui.

### 4. VS Code (via servidor local, comando `code`)

Cada pasta cadastrada ganha um botão "abrir no VS Code". Em vez de um link
`vscode://file/...` direto do navegador (que dispara um diálogo de
confirmação do tipo "este site quer abrir o VS Code?" na primeira vez em
cada navegador/perfil), o servidor local dispara o comando `code
<caminho-absoluto>` diretamente — mesmo mecanismo de processo que já usamos
pro `osascript`, sem diálogo nenhum.

Pré-requisito de uma vez só: no VS Code, `Cmd+Shift+P` → "Shell Command:
Install 'code' command in PATH" — depois disso o comando `code` fica
disponível pra qualquer processo na sua máquina.

Quando o projeto tem mais de uma pasta (frontend + backend + infra), o
servidor gera um arquivo `.code-workspace` referenciando as três e roda
`code caminho.code-workspace` — um clique, as três pastas juntas na mesma
janela do VS Code. Esse é o jeito documentado e garantido de abrir multi-root
no VS Code (existe a possibilidade de passar várias pastas direto como
argumentos do `code` e ele juntar numa janela só, mas isso não está
documentado com certeza suficiente pra confiar sem testar — o
`.code-workspace` é o caminho seguro).

### 5. Trello (aba real do navegador)

Pra tudo que o app **não** reconstrói — comentar num card, anexar arquivo,
editar descrição, adicionar label, reordenar dentro da lista. O app mostra o
essencial (título, status, ações rápidas — seção 3), mas não vira um clone
do Trello; qualquer edição mais rica manda você pro board de verdade. O
botão "abrir no Trello", tanto na aba Projetos quanto na aba de detalhe, é
só `<a href="{trelloBoardUrl}" target="_blank">` — abre uma aba de verdade
do navegador, com o Trello completo e atualizado, sem nenhuma limitação.

### 6. Botão "abrir com Claude" (por atividade)

Na aba de detalhe, cada card listado ganha um botão que:

1. Servidor busca a descrição completa daquele card (`GET /1/cards/:id`) —
   é a única vez que o conteúdo do card é lido, sob demanda, não em lote
2. Servidor dispara um `osascript` (AppleScript) que abre uma nova janela do
   **Terminal.app**, faz `cd` pra pasta certa do projeto, e roda `claude`
   passando a descrição do card como prompt inicial
3. Servidor também roda `code <pasta-do-projeto>` — abre o VS Code na mesma
   pasta, pra você acompanhar o diff ao vivo pela aba **Source Control**
   enquanto o Claude trabalha (é um clique a mais pra alternar pra essa aba
   dentro do VS Code — não achei um jeito confiável de já abrir direto nela
   via linha de comando). O VS Code aqui não é ferramenta de edição sua, é
   só janela de acompanhamento — quem edita é o Claude
4. Servidor faz `PUT` no card movendo ele pra lista "Em andamento" — fecha o
   ciclo, o Trello reflete que a tarefa começou

Isso adiciona a única escrita real que o sistema faz no Trello: mover o card
de lista quando a tarefa é iniciada por esse botão. Tudo o mais (comentar,
anexar, editar descrição) continua sendo feito no Trello mesmo.

Detalhe técnico: descrições longas ou com aspas/quebras de linha não vão bem
direto num comando AppleScript — o mais seguro é o servidor escrever a
descrição num arquivo temporário e o comando do terminal ser algo como
`claude "$(cat /tmp/tarefa-xyz.txt)"`, evitando problema de escaping.

### 7. Branch por atividade + retomada

Cada atividade tem sua própria branch, nomeada de forma determinística a
partir do ID do card — `task/<id-do-card>`. Não precisa guardar esse nome em
lugar nenhum: o mesmo card sempre gera o mesmo nome de branch, então retomar
é só resolver o ID de novo.

Ao clicar em "abrir com Claude":

- **Card pendente** → servidor cria a branch (`git checkout -b task/<id>`) e
  abre o Claude Code com o prompt da tarefa
- **Card já em "Em andamento"** (retomando algo pausado) → servidor só faz
  `git checkout task/<id>` na branch existente, e o prompt inicial do Claude
  Code instrui: "leia o STATUS.md antes de continuar"

**`STATUS.md`** — arquivo na raiz do projeto, commitado na própria branch da
tarefa, com o que já foi feito e o que falta. Não aparece no Trello — fica só
na branch, é o primeiro lugar que o Claude Code olha ao retomar.

**Commit + push** — não é um botão, é uma instrução permanente no `CLAUDE.md`
daquela branch: sempre que a sessão for interrompida (pedido explícito de
parar, ou fim natural da tarefa), o Claude Code atualiza o `STATUS.md`,
commita e dá push antes de encerrar. Commitar com frequência ao longo do
trabalho (não só no fim) reduz o risco de perder progresso se o terminal for
fechado à força.

**Uma atividade ativa por projeto de cada vez** — como não há worktrees, o
projeto vive numa pasta só, então só uma branch fica de fato "no disco" por
vez. Antes de trocar de branch (iniciar outra atividade do mesmo projeto), o
servidor confere se a árvore está limpa (`git status --porcelain`); se
houver mudança não commitada, ele recusa a troca em vez de descartar
trabalho silenciosamente.

### 8. Seções (grupos de projetos correlacionados)

Uma camada visual acima da aba Projetos: um canvas livre onde você organiza
projetos que precisam rodar juntos (ex: frontend + backend + infra do mesmo
sistema) dentro de retângulos redimensionáveis — as seções. Tudo por drag
and drop: arrastar um projeto pra dentro/fora de uma seção, redimensionar a
borda da seção. Uma seção pode existir vazia, esperando projetos.

Armazenamento — um `sections.json` novo, simples:

```json
{
  "id": "sec-1",
  "name": "App Principal",
  "position": { "x": 40, "y": 40, "width": 480, "height": 260 },
  "projectIds": ["proj-123", "proj-456"]
}
```

**Novo campo no CRUD de projeto**: `runCommand` (ex: `npm run dev`,
`docker compose up`). Um projeto sem esse campo é um bloco **não
configurado** — fica com um indicativo visual permanente no canvas, não só
quando você tenta rodar.

**Botão play na seção**:

1. Servidor confere se todos os `projectIds` da seção têm `runCommand`
   preenchido. Se algum não tiver, bloqueia com o erro "nem todos os
   projetos do grupo/seção estão configurados" e destaca o(s) bloco(s)
   faltante(s)
2. Se todos ok: pra cada projeto, o servidor gera um `.plist` (agente do
   **launchd**, o gerenciador de processos do macOS — equivalente ao
   `systemctl`/systemd do Linux, mas com ferramenta e formato diferentes) e
   carrega ele com `launchctl bootstrap`. O `.plist` já define pra onde vai
   a saída: um arquivo de log por projeto, tipo
   `~/Library/Logs/launcher/sec-1-proj-123.log`
3. Servidor abre **uma janela do Terminal.app com uma aba por projeto**,
   mas cada aba só roda `tail -f` no arquivo de log daquele projeto — quem
   sobe o processo de verdade é o launchd, a aba só mostra a saída ao vivo

**Botão parar tudo**: `launchctl bootout` em cada agente da seção. O próprio
sistema operacional garante que o processo e os filhos dele (ex: o Vite que
o `npm run dev` sobe por baixo) são encerrados direito — sem a gambiarra de
capturar PID manualmente e sem risco de processo órfão ficando preso numa
porta. Fechar a aba do `tail -f` por engano também não é problema: ela só
está _olhando_ o log, não é o processo em si, então "parar tudo" continua
funcionando mesmo se a aba não existir mais.

**Botão "ver diffs do grupo"**: gera um `.code-workspace` referenciando as
pastas de todos os projetos da seção (mesmo mecanismo do componente 4, só
que no nível da seção em vez de um projeto só) e abre com `code`. Útil
quando o Claude está trabalhando em atividades de mais de um projeto do
mesmo grupo ao mesmo tempo (ex: uma tarefa no frontend e outra no backend,
do mesmo sistema) — a aba Source Control do VS Code agrupa os diffs de cada
repositório separadamente dentro da mesma janela, então você vê tudo junto
sem abrir uma janela por projeto. É uma ação manual, separada do play/parar
— não abre nem fecha sozinha junto com a execução dos projetos.

**Indicativo de "rodando" na aba Projetos**: cada agente do launchd recebe
um label previsível, `com.launcher.<id-do-projeto>`. Quando a aba Projetos
carrega (ou periodicamente, enquanto ela está aberta), o servidor roda
`launchctl list | grep com.launcher.` uma única vez — não uma consulta por
projeto — e cruza os labels encontrados com os IDs cadastrados. Quem
aparecer na lista ganha um indicativo visual de "rodando" no card, mesmo
que você tenha iniciado a seção há horas e esquecido que ainda está no ar.

---

## Fluxo de uso

1. Você abre o app, cai na aba Projetos — já vê todos os projetos com um
   resumo tipo "3 pendentes · 5 em andamento"
2. Clica em "abrir no VS Code" de um projeto → editor abre na hora, sem sair
   do app
3. Clica em "detalhar" → abre uma aba interna com as pastas do projeto e o
   resumo mais completo
4. Precisa mover um card, comentar, anexar algo → clica em "abrir no Trello"
   → aba real do navegador, Trello completo
5. Quer começar uma atividade específica com ajuda do Claude → clica em
   "abrir com Claude" naquele card → Terminal.app abre já na pasta certa,
   numa branch nova pra essa tarefa, com o Claude Code rodando e o prompt
   carregado, e o card já pula pra "Em andamento" no Trello
6. Precisou parar no meio → o Claude Code deixa o `STATUS.md` atualizado,
   commita e dá push antes de encerrar
7. Volta depois pra continuar → clica em "abrir com Claude" no mesmo card →
   servidor faz checkout na mesma branch, Claude Code lê o `STATUS.md` e
   retoma de onde parou

---

## Decisões

- Sem execução remota, sem worktrees, sem SSH/Tailscale — descartado por
  complexidade desproporcional ao objetivo (reduzir fricção, não construir
  infraestrutura)
- Sem MCP — a comunicação com o Trello é direta via API REST, porque não há
  interpretação de linguagem natural envolvida, só leitura de dados
  estruturados
- Sem kanban reconstruído — o Trello não permite embed interativo, e
  reconstruir manutenção de UI que já existe pronta não compensa
- API do Trello usada majoritariamente **para leitura** (resumo, lista de
  cards, descrição sob demanda) — a única escrita é mover o card pra "Em
  andamento" quando a tarefa é iniciada via botão "abrir com Claude"
- Terminal: **Terminal.app** (padrão do macOS), acionado via `osascript`
  pelo servidor local — sem SSH, sem rede, tudo na própria máquina
- Uma branch por atividade (`task/<id-do-card>`), sem worktrees — só uma
  atividade ativa por projeto de cada vez, o que é suficiente pro seu uso
- Status de retomada (o que já foi feito, o que falta) vive só no
  `STATUS.md` da branch — não é espelhado no Trello
- Seções agrupam projetos correlacionados num canvas livre (drag and drop),
  com play/parar tudo em paralelo — cada projeto roda como agente do
  **launchd** (não como processo direto na aba), e a aba de Terminal.app só
  mostra o log ao vivo via `tail -f`. Isso resolve de forma nativa o
  problema de processo órfão, sem precisar rastrear PID manualmente
- "Configurado" pra fins de play na seção = só o `runCommand` precisa
  estar preenchido (pasta e link do Trello não bloqueiam a execução)

## Em aberto

- Servidor local em Node — precisa decidir o framework (Express é o caminho
  mais direto, sem exigir nada além do básico)
- Onde `projects.json` fica salvo — pasta do próprio app, ou em algum lugar
  versionável (ex: dotfiles) pra sobreviver a reinstalações
- Frequência de atualização do resumo — buscar toda vez que a aba Projetos
  abre, ou cachear por alguns minutos pra não gastar as chamadas da API à toa
- Onde `sections.json` fica salvo (provavelmente junto de `projects.json`,
  mesma pasta)
