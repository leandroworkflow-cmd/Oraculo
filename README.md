# Zodam AI

Painel de mercados com cotações ao vivo, notícias dos principais jornais, clima global, risco, projeções, oportunidades e o Zodam, uma IA em forma de holograma: você fala ou digita, ele responde por texto e por voz, usando os dados que estão na tela.

## IA grátis

Escolha uma, crie a chave sem cartão de crédito e coloque no arquivo `.env`:

| Opção | Onde criar a chave | Variável |
|---|---|---|
| Gemini (recomendado) | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
| Groq (Llama) | https://console.groq.com/keys | `GROQ_API_KEY` |
| Claude (pago, opcional) | console.anthropic.com | `ANTHROPIC_API_KEY` |

O modelo padrão do Groq é o `openai/gpt-oss-120b`. Os provedores aposentam modelos com frequência: se aparecer "model is no longer available" no painel, troque o modelo na variável `GROQ_MODEL` (ou `GEMINI_MODEL`) por um da lista atual do provedor. Se houver chaves de mais de um provedor, defina `AI_PROVIDER=groq` para usar o Groq.

Sem nenhuma chave, o painel funciona em modo local: o risco sai de regras, as projeções são estatísticas e o chat responde cotações e manchetes. Os limites do plano gratuito mudam com o tempo; o servidor guarda a análise em cache por 15 minutos para gastar poucas chamadas.

A voz (falar e ouvir) vem do próprio navegador, sem custo. Use Chrome ou Edge; o microfone pede permissão na primeira vez.

## Rodar no computador

Requer Node 18 ou superior. Não há dependências para instalar.

```bash
cp .env.example .env     # preencha GEMINI_API_KEY
node server.js
```

Abra http://localhost:3000

## Publicar na Vercel

1. Envie o projeto para o GitHub e importe o repositório na Vercel.
2. Em Settings → Environment Variables, crie `GEMINI_API_KEY` com a sua chave.
3. Faça um novo deploy. As rotas ficam na pasta `api/` e o painel em `public/`.

Nunca coloque a chave no código nem no GitHub. O `.gitignore` já exclui o `.env`.

## Fontes de dados (gratuitas, sem chave)

Yahoo Finance (cotações, endpoint público não oficial), AwesomeAPI e CoinGecko (reserva), alternative.me (medo e ganância cripto), Open-Meteo (clima) e feeds RSS de BBC, NYT, The Guardian, Al Jazeera, DW, CNBC, Folha e G1.

## Personalizar

- Ativos: lista `ASSETS` em `server.js`. Jornais: lista `FEEDS`. Cidades do clima: lista `CITIES`.
- Visual e voz: `public/index.html`.

## Aviso

Conteúdo informativo. Projeções são cenários e extrapolações, não previsões, e nada aqui é recomendação de investimento.
