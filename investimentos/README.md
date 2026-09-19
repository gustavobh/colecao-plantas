# Gestão de Investimentos

Carteira de ações, FIIs, renda fixa e ETFs com foco em **acompanhar dividendos**.
Roda no seu computador, guarda tudo em SQLite no seu disco, sem conta, sem
servidor de terceiro e sem mensalidade.

**O que ele responde**

| A pergunta | Onde está |
| --- | --- |
| "Quanto eu recebi de provento este mês?" | Número de topo, com média dos últimos 12 meses |
| "Estou recebendo mais do que ano passado?" | Comparação entre as duas janelas de 12 meses |
| "Quais papéis pagam de verdade?" | Ranking por ativo, com yield sobre o que você pagou |
| "Quanto entra mês que vem?" | Calendário de proventos anunciados e ainda não creditados |
| "Meu FII está pagando ou devolvendo meu dinheiro?" | Amortização contabilizada separada do rendimento |
| "Falta alguma coisa no meu histórico?" | Divergência entre o que você lançou e o que a corretora reporta |

---

## De onde vêm os dados

Conexão direta com B3, Nubank e Inter **não existe para pessoa física**, e vale
saber por quê antes de procurar:

| Instituição | Situação |
| --- | --- |
| **B3** | Tem API oficial da Área Logada do Investidor, só que a contratação é restrita a fintechs e instituições financeiras, via contrato comercial |
| **Nubank** | Nunca teve API pública. A `pynubank` parou de funcionar em agosto de 2023, quando o banco passou a exigir verificação facial |
| **Inter** | A API de desenvolvedor é exclusiva de conta PJ, e cobre banking (saldo, extrato, Pix), sem carteira de renda variável |
| **Open Finance direto** | Ser receptor exige autorização do Banco Central, certificado mTLS e conformidade FAPI. É questão de licença, não de preço |

O caminho que funciona são três fontes combinadas:

### 1. Meu Pluggy (Open Finance), gratuito

O [Meu Pluggy](https://meu.pluggy.ai) é o portal pessoal da Pluggy, distinto do
plano comercial de R$ 2.500/mês. Para uso pessoal é **gratuito por tempo
indeterminado**: até 5 conexões ativas, só contas do mesmo titular, atualização
automática a cada 24 horas, sem aprovação prévia. Você precisa de 3 conexões.

O Dashboard mostra um aviso de "teste de 15 dias". Esse contador é da parte
comercial e não limita o uso pessoal.

```bash
# 1. Crie a conta em meu.pluggy.ai e conecte B3, Nubank e Inter
# 2. Copie Client ID e Client Secret do Dashboard para o .env
# 3. Sincronize
curl -X POST http://127.0.0.1:8000/api/sincronizar/pluggy
```

### 2. Excel da B3, como lastro histórico

Na Área do Investidor, em **Extratos e Informativos › Movimentação**, exporte
para Excel e mande o arquivo para o app. Esse arquivo é a fonte mais confiável
de proventos que existe para carteira brasileira: traz cada dividendo, JCP,
rendimento e amortização com data de crédito e valor exato.

Vale manter mesmo com a Pluggy ligada, por dois motivos concretos:

- O campo `transactions` de investimentos da Pluggy está **deprecado** para
  aplicações criadas depois de março de 2023, então o detalhamento por evento
  pode vir incompleto.
- Há relato consistente de transações que aparecem numa chamada e somem na
  seguinte. O app nunca apaga lançamento por ausência na API, e o Excel serve
  para preencher buraco de histórico.

### 3. APIs públicas, para preço e calendário

| Fonte | Para quê | Custo |
| --- | --- | --- |
| [brapi.dev](https://brapi.dev) | Cotação e proventos de ações, FIIs e ETFs da B3 | Grátis com token |
| Yahoo Finance | Cotação e dividendos de ETFs e ações americanas | Grátis, sem cadastro |
| [API do Banco Central](https://dadosabertos.bcb.gov.br) | CDI, SELIC, IPCA e PTAX | Aberta |

---

## Rodando

```bash
pip install -e .
cp .env.example .env          # preencha PLUGGY_* e BRAPI_TOKEN quando tiver
uvicorn app.main:app --reload
```

Painel em `http://127.0.0.1:8000`, documentação da API em `/docs`.

Para conhecer o app antes de plugar suas contas, uma carteira fictícia com três
anos de histórico:

```bash
python scripts/dados_exemplo.py --limpar
```

---

## Como é por dentro

### O livro-razão não apaga nada

`Movimentacao` é append-only. Conectores de Open Finance omitem transações
antigas de forma silenciosa, então **ausência na API nunca significa estorno**.
Só a remoção manual tira um lançamento do banco.

Cada lançamento carrega uma `impressao`, hash de conta, ativo, data, tipo,
quantidade e valor (ou do id externo, quando a origem fornece um). Com
`UniqueConstraint` no banco como garantia real, reimportar o mesmo Excel dez
vezes não duplica nada.

### Posição é derivada, nunca armazenada

O saldo de cada ativo sai de somar o livro-razão em ordem cronológica. Corrigir
um lançamento antigo conserta todo o histórico sem migração.

O preço médio segue a regra brasileira: **venda não altera o preço médio**,
apenas reduz a quantidade e realiza lucro contra o médio vigente.
Desdobramento e grupamento mexem na quantidade sem tocar no custo total, que é
o que faz o preço médio cair ou subir na proporção certa.

### Renda e caixa não são a mesma coisa

Amortização de FII cai na conta igual a um rendimento, só que é o fundo
devolvendo principal. Somar as duas infla o yield e faz um fundo em liquidação
parecer o melhor pagador da carteira. O app trata amortização como redução de
custo, mostra ela separada no gráfico e a mantém fora do yield on cost.

### Dólar é convertido antes de somar

Posição e provento em moeda estrangeira passam pela PTAX antes de entrar em
qualquer total. Quando a taxa do dia do evento está gravada, ela tem
prioridade; sem ela, a taxa atual serve de aproximação. Moeda sem taxa nenhuma
aparece em `cambio_ausente`, em vez de virar um número errado silencioso.

### O painel avisa quando não sabe

Ativo sem cotação, posição com custo incompleto (papel que entrou por
transferência de custódia sem valor informado), divergência entre o livro-razão
e o que a corretora reporta: tudo isso aparece na tela em vez de ser escondido
atrás de um número redondo.

---

## Estrutura

```
app/
  models.py            modelo de dados e as regras de sinal de cada evento
  carteira.py          posição, preço médio e conversão de moeda
  proventos.py         série mensal, ranking, projeção e calendário
  db.py                conexão e escrita idempotente
  conectores/pluggy.py Open Finance
  importadores/        Excel da B3
  fontes/              brapi, Yahoo Finance e Banco Central
  routers/             API HTTP
web/                   painel, JavaScript puro e SVG desenhado à mão
scripts/               carteira de exemplo
testes/                49 testes, sem rede
```

## Testes

```bash
pytest
```

Cobrem o que erra em silêncio: preço médio com venda parcial, desdobramento,
grupamento, amortização de FII, JCP líquido de imposto, conversão de moeda,
importação repetida, planilha com cabeçalho deslocado, movimentação
desconhecida e carteira vazia.

Nenhum teste toca a rede.
