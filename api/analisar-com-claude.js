// ═══════════════════════════════════════════════════════════════
// API Vercel - Análise de Imagens Médicas com Claude Vision
// Arquivo: /api/analisar-com-claude.js
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  // ✅ ADICIONAR HEADERS CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Responder a preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Aceitar apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido. Use POST.' });
  }

  try {
    // Extrair dados do request
    const { imagemBase64, laboratorioBase64, laboratorioTexto, tipo, queixa, sintomas, sinaisVitais, medicamentos, historico } = req.body;

    // Validar campos obrigatórios
    if (!imagemBase64 || !tipo) {
      return res.status(400).json({ 
        erro: 'Campos obrigatórios faltando: imagemBase64, tipo' 
      });
    }

    // Verificar API Key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('🔑 API Key presente?', !!apiKey);
    if (!apiKey) {
      console.error('❌ ANTHROPIC_API_KEY não está configurada!');
      return res.status(500).json({ 
        erro: 'API Key não configurada no servidor' 
      });
    }

    // Inicializar cliente Anthropic
    const client = new Anthropic({
      apiKey: apiKey
    });

    // ═══════════════════════════════════════════════════════════════
    // CONSTRUIR CONTEÚDO PARA CLAUDE
    // ═══════════════════════════════════════════════════════════════

    const conteudo = [];

    const temLaboratorio = !!(laboratorioBase64 || laboratorioTexto);

    // Adicionar texto inicial
    conteudo.push({
      type: 'text',
      text: `Você é um radiologista especializado em análise de imagens médicas. 
Analise a imagem enviada e forneça um laudo detalhado.

DADOS DO PACIENTE:
- Tipo de exame: ${tipo}
- Queixa principal: ${queixa || 'Não informada'}
- Sintomas: ${sintomas || 'Não informados'}
- Sinais vitais / triagem (enfermagem): ${sinaisVitais || 'Não informados'}
- Medicamentos em uso: ${medicamentos || 'Não informados'}
- Histórico: ${historico || 'Não informado'}
${laboratorioTexto ? `- Resultado de laboratório (informado em texto): ${laboratorioTexto}` : ''}

Por favor, forneça um laudo estruturado com:
1. DADOS DO EXAME
2. ACHADOS PRINCIPAIS
3. ACHADOS LABORATORIAIS (se aplicável)
4. ACHADOS CORRELACIONADOS
5. IMPRESSÃO DIAGNÓSTICA
6. RECOMENDAÇÕES CLÍNICAS
7. OBSERVAÇÕES FINAIS

Seja preciso, técnico e apropriado para um médico nas seções 1 a 7 acima.

Depois da seção 7, inclua uma seção adicional, EXATAMENTE com este título em uma linha própria:
RESUMO PARA PRONTUÁRIO:
${temLaboratorio ? `
Nessa seção, primeiro transcreva um resumo ABREVIADO dos exames de laboratório fornecidos (imagem e/ou texto), EXATAMENTE neste formato — agrupado por categoria, sigla: valor separados por " | ", uma linha por categoria, linha em branco entre categorias, SEM nenhuma observação ou interpretação clínica nesse bloco:

HEMOGRAMA:
HEM: 4,82 | HB: 14,1 g/dL | HT: 43,0% | VCM: 89,2 fL | HCM: 29,3 pg | CHCM: 32,8 g/dL | RDW: 13,2%

LEUCOGRAMA:
LEUCO: 15.720/mm³ | BAST: 0% | SEG: 92% | EOS: 0% | BAS: 0% | LINF: 4% | MONO: 4%

PLAQ: 194.000/mm³

FUNÇÃO RENAL:
UR: 47 mg/dL | CR: 0,93 mg/dL | TFGe: 82 mL/min/1,73m²

ELETRÓLITOS:
Na: 134 mEq/L | K: 5,3 mEq/L

(O exemplo acima é só pra você entender o FORMATO — use as categorias e abreviações que realmente aparecem no exame fornecido, que pode ser hemograma, bioquímica, gasometria, coagulograma, urina, etc. Não invente valores nem categorias que não foram informados.)

Depois desse bloco abreviado de laboratório, escreva` : `Nessa seção, escreva`} um resumo clínico curto (de 3 a 5 frases), em linguagem direta e natural, do jeito que um médico escreveria à mão num prontuário. Regras importantes pra essa parte:
- NÃO use markdown (sem **, sem #, sem listas com hífen)
- NÃO use títulos em negrito ou numeração
- Apenas texto corrido, em parágrafo único
- Contenha só o essencial: achado principal, impressão diagnóstica e conduta/recomendação
- Deve estar pronto pra ser copiado e colado direto no sistema de prontuário eletrônico, sem precisar editar nada`
    });

    // Adicionar imagem principal (obrigatória)
    conteudo.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: imagemBase64
      }
    });

    // Adicionar imagem de laboratório (opcional)
    if (laboratorioBase64) {
      conteudo.push({
        type: 'text',
        text: 'Aqui está também a imagem de laboratório/exames complementares:'
      });
      
      conteudo.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: laboratorioBase64
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CHAMAR CLAUDE VISION API
    // ═══════════════════════════════════════════════════════════════

    console.log('📤 Chamando Claude Vision API...');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: conteudo
        }
      ]
    });
    console.log('✅ Resposta de Claude recebida!');

    // Extrair texto da resposta
    const laudoCompleto = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    // ═══════════════════════════════════════════════════════════════
    // RETORNAR RESPOSTA
    // ═══════════════════════════════════════════════════════════════

    return res.status(200).json({
      sucesso: true,
      laudo: laudoCompleto,
      tipo: 'laudo_completo',
      timestamp: new Date().toISOString(),
      modelo: 'claude-sonnet-4-6',
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens
      }
    });

  } catch (erro) {
    console.error('❌ Erro COMPLETO na API:', {
      message: erro.message,
      status: erro.status,
      error: erro.error,
      stack: erro.stack
    });

    // Erros específicos
    if (erro.message.includes('401') || erro.status === 401) {
      return res.status(401).json({ 
        erro: 'API Key inválida ou expirada',
        detalhes: erro.message 
      });
    }

    if (erro.message.includes('429') || erro.status === 429) {
      return res.status(429).json({ 
        erro: 'Limite de requisições atingido',
        detalhes: 'Aguarde um momento e tente novamente' 
      });
    }

    // Erro genérico
    return res.status(500).json({
      erro: 'Erro ao processar requisição',
      detalhes: erro.message,
      tipo: 'server_error'
    });
  }
}
