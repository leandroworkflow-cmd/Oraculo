# MarketOS

Painel futurista de mercados com cotações ao vivo, notícias dos principais jornais, risco global, projeções, oportunidades e um chat com IA que responde com base nos dados da tela.

## Rodar

Requer Node 18 ou superior. Não há dependências para instalar.

```bash
cp .env.example .env        # opcional: coloque sua ANTHROPIC_API_KEY
node server.js
```

Abra http://localhost:3000

Sem chave de IA, o painel funciona em modo local: o risco é calculado por regras (VIX, tom das manchetes, variações de ouro, petróleo, dólar, bitcoin e juros), as projeções são estatísticas e o chat responde cotações e manchetes. Com `ANTHROPIC_API_KEY`, a IA escreve o briefing, o risco global, as projeções e as oportunidades, e o chat responde perguntas abertas usando o snapshot atual do painel.

## Fontes de dados (gratuitas, sem chave)

| Dado | Fonte | Observação |
|---|---|---|
| Dólar, euro, DXY, ouro, prata, petróleo, cobre, bolsas, VIX, juro 10 anos | Yahoo Finance (endpoint público não oficial) | Pode ter atraso e mudar sem aviso |
| Dólar/Euro (reserva) | AwesomeAPI | Usada se o Yahoo falhar |
| Bitcoin e Ethereum | Yahoo Finance, com CoinGecko como reserva | CoinGecko limita requisições por minuto |
| Medo e ganância cripto | alternative.me | |
| Notícias | RSS de BBC, NYT, The Guardian, Al Jazeera, DW, CNBC, Folha e G1 | Reuters, FT e Bloomberg não têm RSS gratuito |

O servidor guarda as respostas em cache (cotações 45 s, notícias 10 min, análise da IA 15 min) para ficar dentro dos limites gratuitos e economizar chamadas de IA.

## Publicar online

Qualquer hospedagem com Node serve (Render, Railway, Fly.io, VPS). Defina `ANTHROPIC_API_KEY` como variável de ambiente no painel da hospedagem e use `node server.js` como comando de início. Não publique o arquivo `.env`.

## Personalizar

- Ativos: edite a lista `ASSETS` em `server.js` (símbolo do Yahoo Finance em `yf`).
- Jornais: edite a lista `FEEDS` em `server.js`.
- Modelo de IA: variável `ANTHROPIC_MODEL`.
- Visual: tudo em `public/index.html`.

## Aviso

Conteúdo informativo. Projeções são cenários e extrapolações, não previsões, e nada aqui é recomendação de investimento.
