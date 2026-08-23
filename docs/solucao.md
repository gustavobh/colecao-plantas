# Por que o app é assim

Registro das decisões de projeto. Serve para quem for mexer no código depois
(inclusive o autor daqui a um ano) entender o que foi escolha e o que foi acaso.

## O problema, dito com precisão

Três dores, e elas não são a mesma:

1. **Inventário.** "Não sei quais espécies eu tenho." É um problema de listagem
   e de busca. Nenhuma inteligência artificial resolve; resolve-se cadastrando.
2. **Recuperação.** "Esqueço o nome de algumas." A planta já foi identificada um
   dia — o que falhou foi lembrar. É um problema de consulta rápida a partir de
   pistas frouxas ("aquela do fundo, de flor amarela").
3. **Descoberta.** "Outras eu não conheço." Aí sim é identificação.

A maior parte dos apps de planta ataca só a terceira e trata as outras duas como
consequência. É o contrário: as duas primeiras é que dão o valor diário, e são
as mais baratas de implementar. A identificação é a mais chamativa e a menos
confiável.

Por isso o app permite **salvar sem nome nenhum**. Uma planta sem nome no
inventário já vale — ela vira uma pendência visível em vez de uma dúvida vaga.

## Decisão 1 — PWA, não app nativo

| | PWA | Swift nativo | React Native / Expo |
| --- | --- | --- | --- |
| Custo para publicar | zero | US$ 99/ano + revisão | US$ 99/ano + revisão |
| Precisa de Mac | não | sim | quase sempre |
| Instalar no iPhone | Adicionar à Tela de Início | App Store | App Store / TestFlight |
| Câmera e GPS | sim | sim | sim |
| Offline | sim | sim | sim |
| Manutenção em 5 anos | abre igual | recompilar a cada iOS | tratar quebras de dependência |

Para um app de um usuário só, num terreno só, a App Store é puro custo: taxa
anual, revisão, certificado que vence, build que precisa de máquina Apple. O PWA
entrega câmera, GPS, armazenamento local e ícone na tela inicial sem nada disso.

**O que se perde:** notificação push confiável, widget, integração com Fotos do
iOS, e o app não aparece em busca na App Store. Nenhum desses é necessário aqui.

**O risco real que se assume:** o Safari apaga o armazenamento de sites sem uso.
Duas mitigações — instalar na Tela de Início (a instalação escapa dessa regra) e
o backup exportável, que a tela de Ajustes cobra quando fica velho.

## Decisão 2 — sem servidor e sem conta

Não há login, não há nuvem, não há banco. Consequências assumidas:

- não sincroniza entre aparelhos (o backup faz a ponte manual);
- nada de custo mensal, de vazamento de dados, de "a empresa fechou e levou meu
  jardim junto";
- as fotos do quintal e as coordenadas da casa não passam por servidor nenhum.

Para uma coleção pessoal, essa troca é claramente favorável. Se um dia virar
coisa de duas pessoas mexendo, aí sim vale um servidor — e o formato do backup
já está pronto para virar carga inicial.

## Decisão 3 — identificação com evidência regional, não veredito

O Pl@ntNet é o melhor reconhecedor de plantas com API pública gratuita, mas é
treinado no mundo inteiro e tem viés europeu. Num jardim de Cerrado ele sugere,
com boa confiança, primas do hemisfério norte.

O app corrige isso com dois sinais, ambos visíveis na tela:

1. **Ocorrência regional (GBIF).** Para cada candidato, quantos registros da
   espécie existem num raio de 150 km do terreno. Uma espécie com centenas de
   registros aqui perto é muito mais provável que uma sem nenhum.
2. **Gênero de Cerrado (`js/cerrado.js`).** Lista offline de gêneros
   característicos do bioma, com um peso suave. Também tem a lista inversa, de
   gêneros que por aqui só existem em jardim.

Os dois entram como **peso sobre a nota**, nunca como substituto dela, e a nota
original continua na tela. O app nunca marca uma espécie sozinho: quem confirma
é o dono do jardim. Um app que grava a espécie errada em silêncio contamina a
coleção inteira, e o erro só aparece meses depois.

Quando a Flora e Funga do Brasil responde, o que ela diz sobre origem e domínio
fitogeográfico vale mais que a heurística de gênero — é a fonte oficial. Ela nem
sempre libera consulta pelo navegador, então tudo que vem dela é tratado como
bônus, jamais como requisito.

## Decisão 4 — GPS localiza a região, croqui localiza a planta

Este é o ponto onde a intuição engana. "Identificar por geolocalização" soa como
"o app sabe qual planta é essa porque sabe onde eu estou". Não é o que acontece
num lote pequeno.

- Terreno: 1000 m², mais ou menos 30 x 33 m.
- Erro do GPS do iPhone: 4 a 10 m a céu aberto, pior debaixo de copa de árvore —
  que é exatamente onde as plantas estão.

Plotar as plantas por latitude/longitude num terreno desse tamanho produz uma
nuvem embaralhada: duas plantas em canteiros opostos podem trocar de lugar entre
duas leituras. Seria uma funcionalidade bonita na tela e inútil no quintal.

Então a localização foi dividida em duas coisas com propósitos diferentes:

- **GPS** → serve para *região*: alimenta o filtro de ocorrência do GBIF e marca
  plantas fora de casa. Nisso ele é ótimo.
- **Croqui + canteiro** → serve para *achar a planta*. Você sobe um print de
  satélite do lote e toca onde cada uma está. A posição é guardada em fração da
  imagem (0 a 1), então continua certa se você trocar o print depois.

O campo "canteiro" é texto com sugestão dos que já existem, não uma lista fixa.
Jardim não obedece taxonomia de canteiro, e obrigar a escolher de um menu faz a
pessoa parar de preencher.

## Decisão 5 — foto pelo `<input capture>`, não `getUserMedia`

Dentro de um PWA instalado, o `getUserMedia` no iOS tem histórico de falhar sem
aviso e de exigir permissão persistente de câmera. O `<input type="file"
capture>` abre a câmera nativa do iPhone, entrega a foto em resolução cheia,
oferece a galeria como alternativa no mesmo gesto e não precisa de permissão
especial. Menos controle, muito mais confiabilidade.

Toda foto é reduzida para 1600 px no lado maior antes de ser guardada, com uma
miniatura de 320 px para as listagens. Foto crua de iPhone tem 3 a 5 MB; guardar
assim estoura a cota do Safari depois de algumas centenas de plantas e deixa o
envio lento no 4G do fundo do quintal.

## O que ficou de fora, de propósito

- **Lembretes de rega e adubação.** Vira um app de tarefas. Cerrado nativo, uma
  vez pegando, não quer rega.
- **Rede social, comunidade, comparar com o vizinho.** Nada disso ataca as três
  dores.
- **Reconhecimento de doença por foto.** Estado da arte ainda é fraco; erraria
  mais do que ajudaria.
- **Mapa com camada de satélite ao vivo.** Exigiria chave de API paga e
  conexão, para resolver pior o que o croqui resolve offline.

## Próximos passos naturais

Em ordem de valor por esforço:

1. **Linha do tempo por planta.** As fotos já ficam datadas na ficha; falta
   mostrá-las como sequência — floração ano a ano fica evidente.
2. **Ficha para imprimir/compartilhar**, com QR code para fincar ao lado da
   planta. Útil quando chega visita ou um paisagista.
3. **Calendário fenológico.** Cruzar as datas das fotos de flor e fruto para
   responder "o que floresce em agosto aqui".
4. **Identificação em fila offline.** Hoje a foto fica salva e você identifica
   depois manualmente; dava para tentar sozinho assim que a rede voltar.
5. **Importar a coleção de uma planilha existente**, se já houver uma lista
   antiga em papel ou no Excel.
