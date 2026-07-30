# Guia de Instalação e Utilização — Neroes HRV (Estudo HE26)

Este guia tem duas partes:

1. **Parte A** — passo a passo simples para dar/mostrar aos participantes da atividade.
2. **Parte B** — notas técnicas para a equipa (permissões, causas conhecidas de problemas, o que fazer se algo não correr como esperado).

---

## PARTE A — Guia do participante

### 0. O que vais receber
- Um telemóvel (Android ou iPhone) com a app **Neroes HRV** já instalada.
- Uma banda **Polar H10** com um número (ex: "07"). Esse número é o teu login.

### 1. Instalar a app (só se ainda não estiver instalada)

**Android**
1. Abre o ficheiro `.apk` que te foi enviado.
2. Se aparecer um aviso a pedir para "permitir instalação de apps desconhecidas" para a app que usaste para abrir o ficheiro (Gmail, Ficheiros, Chrome, etc.) — toca em **Permitir** e volta a tentar abrir o ficheiro.
3. Toca em **Instalar**.

**iPhone**
1. Recebes um convite por email/SMS para o **TestFlight**.
2. Se ainda não tiveres a app TestFlight, instala-a primeiro pela App Store (é grátis, da própria Apple).
3. Abre o link do convite → toca em **Instalar** dentro do TestFlight.

Não precisas de ligar o telemóvel a nenhum computador em nenhum dos dois casos.

### 2. Primeira vez que abres a app — permissões

Vai aparecer uma sequência de pedidos de permissão. Aceita todos — são todos necessários para a banda funcionar e para a gravação continuar mesmo com o ecrã bloqueado.

| Pedido | O que fazer |
|---|---|
| Bluetooth / "Dispositivos próximos" | Toca em **Permitir** |
| Notificações | Toca em **Permitir** (é a notificação que mostra o tempo e o BPM durante a gravação) |
| *(Só Android, só depois de ligares à banda pela 1ª vez)* "Desativar otimização de bateria" | Toca em **Desativar** / **Permitir** — sem isto, o telemóvel pode cortar a ligação à banda se ficar muito tempo no bolso |

### 3. Login
1. No campo **"Utilizador"**, escreve o número da tua banda (ex: `07`).
2. Não precisas de palavra-passe.
3. Toca em **Entrar**.

*(Só faz isto na primeira vez — depois de entrares uma vez, a app mantém-te ligado, mesmo sem rede/Wi-Fi.)*

### 4. Ligar à banda
- Veste a banda Polar H10 (contacto direto com a pele, ajustada).
- A app procura e liga-se **automaticamente** à tua banda — não precisas de tocar em nada.
- Quando aparecer "Ligado" (bolinha verde), estás pronto.

Se depois de ~15-20 segundos continuar a dizer "A procurar..." ou "A religar...":
1. Confirma que a banda tem bateria e está bem ajustada (com contacto na pele).
2. Sai da app e volta a abrir.
3. Só se continuar a falhar: vai a **Definições do telemóvel → Bluetooth**, procura "Polar H10" e liga/empareLha manualmente aí, depois volta à app.

### 5. Gravar
1. Escolhe o modo: **5 minutos** (para contagem decrescente automática) ou **Livre** (sem limite de tempo).
2. Toca em **Iniciar**.
3. Podes bloquear o ecrã e colocar o telemóvel no bolso ou numa bolsa — a gravação continua e vais ver uma notificação com o tempo e o teu batimento cardíaco atual.
4. No fim (ou ao tocar em "Terminar"), a app guarda os dados no telemóvel. Se não houver rede no momento (ex: deserto, pirâmides), não faz mal — os dados ficam guardados e são enviados automaticamente quando a rede voltar.

### Perguntas frequentes
- **"Pediu-me para entrar outra vez depois de reabrir a app"** — não devia acontecer; se acontecer, entra normalmente outra vez com o mesmo número.
- **"A banda não liga"** — confirma a bateria e que ninguém mais está a usar essa banda ao mesmo tempo (cada banda só liga a um telemóvel de cada vez).
- **"Não há rede aqui"** — normal, os dados ficam guardados no telemóvel e sincronizam mais tarde sozinhos.

---

## PARTE B — Notas para a equipa

### Distribuição

- **Android**: ficheiro `.apk` assinado (release), enviado por link/email/WhatsApp. Não usa a Play Store — é sideload direto. Cada pessoa só precisa de permitir "fontes desconhecidas" para a app que usa para abrir o ficheiro (não é uma definição global do telemóvel).
- **iOS**: requer conta **Apple Developer Program** (99 USD/ano) associada ao Apple ID da Neroes — **isto só pode ser feito pelo titular da conta**, em [developer.apple.com](https://developer.apple.com/programs/enroll/), com cartão de pagamento e verificação de identidade (pode demorar 24-48h a ser aprovada). Depois de aprovada, a distribuição é via **TestFlight** (App Store Connect → adicionar testadores por email → cada pessoa recebe um convite e instala via app TestFlight). Isto evita ter de ligar cada iPhone a um Mac.

### Permissões — o que cada plataforma pede e porquê

| Permissão | Android | iOS | Porquê |
|---|---|---|---|
| Bluetooth (Scan + Connect) | `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (runtime, Android 12+) | Pedido de sistema na 1ª utilização | Ligar e trocar dados com a banda Polar H10 |
| Notificações | `POST_NOTIFICATIONS` (Android 13+) | Pedido de sistema | Notificação persistente com tempo/BPM durante a gravação; alerta de desconexão |
| Otimização de bateria | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, pedida via ecrã dedicado após a 1ª ligação bem-sucedida | N/A (iOS gere isto de forma diferente, via `UIBackgroundModes: bluetooth-central`) | Garante que o Android não mata o processo/BLE em segundo plano durante sessões longas |
| Foreground Service | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` (declaradas no manifesto, sem prompt ao utilizador) | — | Mantém a app "viva" e prioritária enquanto grava, mesmo com o ecrã bloqueado |

**Nenhuma destas exige "Modo de Desenvolvedor" nem ligação USB** — isso só foi necessário durante o desenvolvimento, para instalar builds de debug via Android Studio/Xcode. Uma APK de release normal, ou uma instalação via TestFlight, nunca pede isso a um participante.

### Login simplificado
- Backend: cada banda "00"–"31" corresponde a uma conta `polar<NN>@healme.pt` com uma password partilhada (não visível na UI). O campo "Utilizador" resolve o número para o email/password reais (`resolveLoginIdentity()` em `src/lib/supabase.js`).
- A conta `formador` mantém password própria, diferente das restantes.
- Sessão fica persistida localmente (`getSession()`, não `getUser()`) — reabrir a app sem rede não força novo login.

### Ligação à banda — regras aprendidas (importante para diagnosticar problemas em campo)

1. **Cada banda só liga a um telemóvel de cada vez.** Se duas pessoas tentarem usar a mesma banda ao mesmo tempo (ex: durante testes), uma delas nunca vai conseguir ligar.
2. **A app liga-se à banda certa automaticamente**, filtrando pelo número de série gravado no perfil do participante (`participants.device_id`, ex: "154D5932") — não é preciso emparelhar manualmente em telemóveis novos/limpos.
3. Se um telemóvel específico **já foi usado para testar várias bandas diferentes** (ex: telemóveis da equipa de desenvolvimento), pode ficar com Bluetooth "confuso" — nesse caso, e só nesse caso, pode ser preciso emparelhar manualmente a banda certa em Definições → Bluetooth antes de abrir a app. Num telemóvel novo dedicado a UM participante, isto nunca deve ser necessário.
4. Foi identificado (e corrigido no código) um bug do próprio Android (visto num Pixel com Android 16) em que o *scan* Bluetooth pode falhar com um erro de permissão mesmo com tudo corretamente concedido — a app já trata este erro sem rebentar, mas se voltar a acontecer em campo: reiniciar o telemóvel resolve na maioria dos casos.

### Reconexão em segundo plano
- Android: reconexão usa o mecanismo nativo `autoConnect` do próprio sistema (não um temporizador da app), para sobreviver a longos períodos em segundo plano/ecrã bloqueado sem ser afetado pelo estrangulamento de temporizadores do Chromium.
- iOS: reconexão via `CBCentralManager` com `restoreIdentifier`, permitindo que o sistema reabra a app em segundo plano para um evento Bluetooth pendente mesmo que o processo tenha sido terminado.

### Resiliência de dados
- Gravação incremental para SQLite local durante a sessão (não só no fim) — um kill do processo a meio nunca perde tudo.
- Sessões órfãs (interrompidas) são recuperadas e marcadas como `recovered` no próximo arranque da app.
- Sincronização automática com o Supabase quando a rede volta (não é preciso reabrir a app).

### Onde tirar dúvidas técnicas
- Código: `app/src/lib/polarBle.js` (ligação BLE), `app/src/lib/supabase.js` (login/auth), `app/src/lib/localSessionStore.js` (armazenamento local).
- Scripts de gestão de participantes: `scripts/seed_participants.py`, `scripts/create_auth_users.py`.
