# Coleção de Plantas

Catálogo do jardim para quem tem mais planta do que memória. Você fotografa,
o app tenta descobrir a espécie cruzando a foto com o que ocorre na sua região,
e o que ele não descobrir fica registrado como "a identificar" para você tentar
de novo quando a planta florescer.

Feito para um terreno de 1000 m² com muita espécie nativa de Cerrado — o tipo
de planta que não aparece em app de jardinagem genérico e que ninguém consegue
memorizar.

**O que ele resolve**

| A dor | O que o app faz |
| --- | --- |
| "Não sei quais espécies eu tenho" | Grade visual com busca por nome, família, canteiro ou nota |
| "Esqueço o nome de algumas" | Ficha com nome científico, nomes populares e resumo em português |
| "Outras eu simplesmente não conheço" | Registro sem nome + identificação por foto quando você quiser |
| "Onde é que está aquela mesmo?" | Croqui do terreno com os pinos, mais o canteiro por escrito |

---

## Como é por dentro

É um **PWA**: um site que você adiciona à Tela de Início e passa a usar como
aplicativo. Sem App Store, sem conta, sem servidor, sem mensalidade.

- **Tudo fica no seu iPhone.** Fotos e coordenadas moram no IndexedDB do Safari.
  A única coisa que sai do aparelho é a foto que você mandar identificar.
- **Funciona offline.** No fundo do quintal, sem 4G, o app abre e registra
  normalmente. A identificação é a única parte que precisa de rede — e ela pode
  esperar.
- **Sem dependências.** JavaScript puro, sem build, sem `npm install` para usar.
  São arquivos estáticos; daqui a cinco anos ainda abrem.

## Instalar no iPhone

1. Publique os arquivos em qualquer endereço **https** (veja abaixo) ou abra o
   endereço que você já tem.
2. No **Safari** (tem que ser o Safari), toque em Compartilhar ›
   **Adicionar à Tela de Início**.
3. Abra pelo ícone. Instalado assim, o iOS deixa de apagar os dados por falta de
   uso — coisa que ele faz com sites comuns depois de alguns dias parado.

## Identificação por foto (opcional)

O reconhecimento usa a API do [Pl@ntNet](https://my.plantnet.org/), gratuita
para uso pessoal (algumas centenas de identificações por dia).

1. Crie a conta em `my.plantnet.org` e pegue a chave na seção **API**.
2. No app: **Ajustes › Chave da API do Pl@ntNet › Salvar chave**.

A chave fica só neste aparelho e **não entra nos backups** que você exporta.

Sem chave, o app continua inteiro: você cadastra, fotografa, organiza e digita
os nomes que souber. Só o botão "Identificar pela foto" fica indisponível.

### O que a geolocalização faz aqui

O Pl@ntNet é treinado no mundo todo e adora sugerir uma prima europeia parecida.
Quando você marca a posição, o app pergunta ao [GBIF](https://www.gbif.org/)
quantos registros de cada espécie candidata existem num raio de 150 km do seu
terreno, e usa isso para reordenar os palpites — mostrando o número na tela.
Uma espécie com 800 registros aqui perto sobe; uma sem nenhum registro no
continente desce.

O app **não** decide sozinho: ele ordena e mostra as evidências, você confirma.

O que a geolocalização **não** faz: separar um canteiro do outro. O GPS erra de
4 a 10 metros, e o terreno inteiro tem 30 x 33 m. Para achar a planta no
quintal servem o campo "canteiro" e o croqui.

## Publicar

Qualquer hospedagem de arquivo estático serve. A mais simples:

**GitHub Pages** — em Settings › Pages, aponte para a branch e a pasta raiz.
Fica em `https://<usuário>.github.io/colecao-plantas/`.

**Localmente, para testar:**

```sh
python3 -m http.server 8765
# abra http://127.0.0.1:8765
```

Câmera, geolocalização e service worker exigem **https** ou `localhost`.

## Backup — leia esta parte

Não há servidor. Se você limpar os dados do Safari, trocar de iPhone ou
desinstalar o app sem exportar, **a coleção acaba**.

Em **Ajustes › Backup**:

- **Exportar backup** gera um `.json` com tudo, fotos incluídas, e abre a folha
  de compartilhamento do iOS para você salvar no iCloud Drive.
- **Restaurar backup** lê esse arquivo de volta. Plantas com o mesmo id são
  substituídas; o que só existe no aparelho continua lá.
- **Exportar planilha (CSV)** gera uma lista da coleção para imprimir ou mandar
  para alguém.

A tela avisa quando o último backup passou de 30 dias.

## Estrutura

```
index.html              casca do app: cabeçalho, área de conteúdo, abas
manifest.webmanifest    metadados de instalação
sw.js                   service worker (o que faz abrir offline)
css/estilo.css          folha única, clara e escura
js/
  app.js                roteador por hash e ciclo de vida das telas
  db.js                 IndexedDB: plantas, fotos, configuração
  imagem.js             reduz e comprime foto antes de guardar
  geo.js                geolocalização e distâncias
  api.js                Pl@ntNet, GBIF, Flora e Funga do Brasil, Wikipédia
  cerrado.js            heurística offline de "isso é do Cerrado?"
  identificacao.js      painel de candidatos, usado em duas telas
  backup.js             exportar/restaurar JSON e CSV
  ui.js                 criação de elementos, avisos, entradas de foto
  views/                uma tela por arquivo
testes/fumaca.mjs       teste de ponta a ponta em iPhone simulado
docs/solucao.md         por que o app é assim, e o que ficou de fora
```

## Rodar os testes

```sh
npm install playwright-core
python3 -m http.server 8765 &
node testes/fumaca.mjs
```

Ele registra plantas de verdade num Chromium com viewport de iPhone, testa
busca, croqui, backup e o modo offline, e falha se algum erro aparecer no
console.

## Privacidade

- Fotos, coordenadas e notas ficam no aparelho. Nada é enviado para lugar nenhum
  por conta própria.
- Ao tocar em "Identificar pela foto", só a imagem vai para o Pl@ntNet, sem nome,
  sem coordenada, sem identificação sua.
- As consultas ao GBIF e à Wikipédia mandam o nome científico do candidato. A
  consulta de ocorrências manda a coordenada arredondada do terreno.
- Nenhum rastreador, nenhuma analítica, nenhum cookie.

## Limites conhecidos

- A identificação por imagem erra bastante fora da época de flor e fruto, e erra
  mais em gramíneas e em plântulas. Ela é um palpite com evidência, não um
  laudo.
- A etiqueta "Cerrado" vem de uma lista de gêneros característicos e da consulta
  à Flora e Funga do Brasil quando ela responde. Serve para orientar; confirme
  antes de citar em algum lugar sério.
- O croqui é um desenho, não um levantamento topográfico.
- É um app de um aparelho só: não sincroniza entre iPhone e iPad. O backup é a
  ponte entre eles.
