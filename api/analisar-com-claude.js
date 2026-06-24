// ═══════════════════════════════════════════════════════════════
// API VERCEL: Análise com Claude Vision
// Deploy em: seu-dominio.vercel.app/api/analisar-com-claude
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  // Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { 
      imagemBase64, 
      laboratorioBase64,
      tipo,           // 'ECG' ou 'RX'
      queixa,         // Queixa principal do paciente
      sintomas,       // Sintomas adicionais
      medicamentos,   // Medicamentos em uso
      historico       // Histórico médico
    } = req.body;

    // Validar entrada
    if (!imagemBase64 || !tipo) {
      return res.status(400).json({ 
        error: 'imagemBase64 e tipo são obrigatórios' 
      });
    }

    // Inicializar cliente Anthropic
    const client = new Anthropic();

    // Montar conteúdo da mensagem
    const content = [
      // IMAGEM MÉDICA
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: imagemBase64
        }
      },

      // EXAME DE LABORATÓRIO (se existir)
      ...(laboratorioBase64 ? [{
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: laboratorioBase64
        }
      }] : []),

      // PROMPT ESTRUTURADO
      {
        type: "text",
        text: `Você é um médico especialista. Gere um LAUDO MÉDICO COMPLETO baseado nos seguintes dados:

INFORMAÇÕES DO PACIENTE:
${queixa ? `- Queixa Principal: ${queixa}` : ''}
${sintomas ? `- Sintomas: ${sintomas}` : ''}
${medicamentos ? `- Medicamentos: ${medicamentos}` : ''}
${historico ? `- Histórico: ${historico}` : ''}

EXAMES FORNECIDOS:
- Tipo: ${tipo} (${tipo === 'ECG' ? 'Eletrocardiograma' : 'Radiografia'})
${laboratorioBase64 ? '- Exame de Laboratório: Incluído' : '- Exame de Laboratório: Não fornecido'}

GERE O LAUDO ESTRUTURADO COM:

1. **DADOS DO EXAME**
   - Tipo de exame
   - Técnica/Qualidade
   - Posicionamento

2. **ACHADOS PRINCIPAIS** (Se ${tipo})
${tipo === 'ECG' ? `   - Frequência cardíaca
   - Ritmo
   - Intervalo PR, QRS, QT
   - Segmento ST
   - Ondas e complexos
   - Anormalidades detectadas` : `   - Estruturas visualizadas
   - Alterações encontradas
   - Localização exata
   - Densidade/Intensidade`}

3. **ACHADOS LABORATORIAIS** (Se fornecido)
   - Valores alterados
   - Comparação com valores de referência
   - Significado clínico

4. **ACHADOS CORRELACIONADOS**
   - Correlação entre imagem e laboratório (se aplicável)
   - Achados concordantes ou discordantes

5. **IMPRESSÃO DIAGNÓSTICA**
   - Diagnóstico principal
   - Diagnósticos diferenciais
   - Nível de confiança

6. **RECOMENDAÇÕES CLÍNICAS**
   - Investigações adicionais (se necessário)
   - Tratamento sugerido
   - Seguimento recomendado
   - Urgência (rotina/semi-urgente/urgente)

7. **OBSERVAÇÕES FINAIS**
   - Limitações do exame
   - Achados secundários
   - Aviso de responsabilidade profissional

⚠️ IMPORTANTE:
- Seja preciso e detalhado
- Use terminologia médica apropriada
- Incluir valores específicos quando aplicável
- Indicar confiança diagnóstica
- Sempre alertar para necessidade de confirmação clínica

Gere o laudo em formato profissional, bem estruturado e pronto para impressão.`
      }
    ];

    // Chamar Claude Vision
    const message = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: content
        }
      ]
    });

    // Extrair laudo
    const laudo = message.content[0].type === 'text' 
      ? message.content[0].text 
      : 'Erro ao gerar laudo';

    // Parsear laudo em seções
    const secoes = parserLaudo(laudo);

    return res.status(200).json({
      sucesso: true,
      laudo: laudo,
      secoes: secoes,
      timestamp: new Date().toISOString(),
      modelo: "claude-3-5-sonnet-20241022"
    });

  } catch (error) {
    console.error('Erro na análise:', error);

    // Tratamento de erros específicos
    if (error.status === 401) {
      return res.status(401).json({ 
        error: 'API Key inválida ou não configurada',
        detalhe: 'Verifique ANTHROPIC_API_KEY em variáveis de ambiente'
      });
    }

    if (error.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit excedido',
        detalhe: 'Aguarde alguns segundos e tente novamente'
      });
    }

    return res.status(500).json({ 
      error: 'Erro ao analisar imagem',
      detalhe: error.message
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// FUNÇÃO AUXILIAR: Parser do laudo
// ═══════════════════════════════════════════════════════════════

function parserLaudo(laudo) {
  const secoes = {};
  
  // Extrair seções principais
  const secoesTexto = [
    'DADOS DO EXAME',
    'ACHADOS PRINCIPAIS',
    'ACHADOS LABORATORIAIS',
    'ACHADOS CORRELACIONADOS',
    'IMPRESSÃO DIAGNÓSTICA',
    'RECOMENDAÇÕES CLÍNICAS',
    'OBSERVAÇÕES FINAIS'
  ];

  secoesTexto.forEach(secao => {
    const regex = new RegExp(`\\*\\*${secao}\\*\\*.*?(?=\\*\\*|$)`, 'is');
    const match = laudo.match(regex);
    secoes[secao] = match ? match[0].replace(/\*\*/g, '').trim() : '';
  });

  return secoes;
}

// ═══════════════════════════════════════════════════════════════
// DEPLOY NO VERCEL:
// 
// 1. npm install @anthropic-ai/sdk
// 2. Adicione em vercel.json:
//    {
//      "env": {
//        "ANTHROPIC_API_KEY": "@anthropic_api_key"
//      }
//    }
// 3. Configure secret em: Vercel Dashboard → Settings → Environment Variables
//    Nome: ANTHROPIC_API_KEY
//    Valor: sua-chave-api
// 4. Deploy: git push
// ═══════════════════════════════════════════════════════════════
