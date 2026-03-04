const { app } = require('@azure/functions');
const axios = require('axios');

/**
 * Azure Function: Processar PDF com OCR e Buscar Unidade
 * 
 * Input (POST body):
 * {
 *   "pdfBase64": "base64_string_do_pdf",
 *   "condominio": "IDEALE",
 *   "unidade": "101",
 *   "bloco": "A" // opcional
 * }
 * 
 * Output:
 * {
 *   "encontrado": true/false,
 *   "inadimplente": true/false,
 *   "condominio": "IDEALE",
 *   "unidade": "101",
 *   "bloco": "A",
 *   "valorTotal": 5432.10,
 *   "valorPrincipal": 4500.00,
 *   "valorMulta": 450.00,
 *   "valorJuros": 482.10,
 *   "mensagem": "string"
 * }
 */

app.http('processOcr', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    context.log('Iniciando processamento OCR');

    try {
      // 1. Parse request body
      const body = await request.json();
      const { pdfBase64, condominio, unidade, bloco } = body;

      if (!pdfBase64 || !condominio || !unidade) {
        return {
          status: 400,
          jsonBody: {
            success: false,
            error: 'Campos obrigatórios: pdfBase64, condominio, unidade'
          }
        };
      }

      // 2. Azure Document Intelligence credentials (de variáveis de ambiente)
      const AZURE_DOC_INTEL_ENDPOINT = process.env.AZURE_DOC_INTEL_ENDPOINT;
      const AZURE_DOC_INTEL_KEY = process.env.AZURE_DOC_INTEL_KEY;

      if (!AZURE_DOC_INTEL_ENDPOINT || !AZURE_DOC_INTEL_KEY) {
        context.log.error('Credenciais Azure não configuradas');
        return {
          status: 500,
          jsonBody: {
            success: false,
            error: 'Credenciais Azure não configuradas'
          }
        };
      }

      // 3. Converter base64 para buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      context.log(`PDF size: ${pdfBuffer.length} bytes`);

      // 4. Enviar para Azure Document Intelligence
      const analyzeUrl = `${AZURE_DOC_INTEL_ENDPOINT}/formrecognizer/documentModels/prebuilt-read:analyze?api-version=2023-07-31`;
      
      context.log('Enviando PDF para Azure OCR...');
      const analyzeResponse = await axios.post(analyzeUrl, pdfBuffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Ocp-Apim-Subscription-Key': AZURE_DOC_INTEL_KEY
        }
      });

      const operationLocation = analyzeResponse.headers['operation-location'];
      if (!operationLocation) {
        throw new Error('Operation-Location header não retornado');
      }

      context.log('OCR iniciado, aguardando resultado...');

      // 5. Polling para aguardar resultado (máximo 60 segundos)
      let ocrResult;
      let attempts = 0;
      const maxAttempts = 30; // 30 tentativas x 2 segundos = 60 segundos

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 segundos
        attempts++;

        const resultResponse = await axios.get(operationLocation, {
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_DOC_INTEL_KEY
          }
        });

        const status = resultResponse.data.status;
        context.log(`OCR status: ${status} (tentativa ${attempts}/${maxAttempts})`);

        if (status === 'succeeded') {
          ocrResult = resultResponse.data.analyzeResult;
          break;
        } else if (status === 'failed') {
          throw new Error('OCR falhou: ' + JSON.stringify(resultResponse.data));
        }
      }

      if (!ocrResult) {
        throw new Error('OCR timeout após 60 segundos');
      }

      // 6. Extrair texto completo
      const fullText = ocrResult.content || '';
      context.log(`Texto extraído: ${fullText.length} caracteres`);

      // 7. Buscar unidade no texto
      const resultado = buscarUnidade(fullText, unidade, bloco, condominio);
      
      context.log('Resultado:', JSON.stringify(resultado));

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        jsonBody: resultado
      };

    } catch (error) {
      context.log.error('Erro ao processar OCR:', error);
      
      return {
        status: 500,
        jsonBody: {
          success: false,
          error: error.message,
          encontrado: false,
          inadimplente: false,
          mensagem: 'Erro ao processar PDF. Tente novamente.'
        }
      };
    }
  }
});

/**
 * Busca unidade no texto extraído do PDF
 */
function buscarUnidade(texto, unidade, bloco, condominio) {
  // Normalizar texto (remover acentos, maiúsculas)
  const textoNormalizado = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  // Padrões de busca
  const padroes = [
    `UNIDADE ${unidade}`,
    `UN ${unidade}`,
    `APT ${unidade}`,
    `APTO ${unidade}`,
    `APARTAMENTO ${unidade}`,
    bloco ? `BL ${bloco} UN ${unidade}` : null,
    bloco ? `BLOCO ${bloco} UNIDADE ${unidade}` : null,
    bloco ? `${bloco}${unidade}` : null,
  ].filter(Boolean);

  // Buscar cada padrão
  let encontrado = false;
  for (const padrao of padroes) {
    if (textoNormalizado.includes(padrao)) {
      encontrado = true;
      break;
    }
  }

  if (!encontrado) {
    return {
      encontrado: false,
      inadimplente: false,
      condominio,
      unidade,
      bloco: bloco || null,
      mensagem: 'Parabéns! Sua unidade não consta no relatório de inadimplência.'
    };
  }

  // Se encontrou, extrair valores
  const valores = extrairValores(texto, unidade, bloco);

  return {
    encontrado: true,
    inadimplente: true,
    condominio,
    unidade,
    bloco: bloco || null,
    ...valores,
    mensagem: `Sua unidade consta no relatório de inadimplência. Valor total devido: R$ ${valores.valorTotal.toFixed(2)}`
  };
}

/**
 * Extrai valores monetários próximos à menção da unidade
 */
function extrairValores(texto, unidade, bloco) {
  // Regex para valores monetários: R$ 1.234,56 ou 1.234,56 ou 1234.56
  const regexValor = /R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/g;

  // Encontrar todas as linhas que mencionam a unidade
  const linhas = texto.split('\n');
  const linhasRelevantes = [];

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i].toUpperCase();
    
    if (
      linha.includes(`UNIDADE ${unidade}`) ||
      linha.includes(`UN ${unidade}`) ||
      linha.includes(`APT ${unidade}`) ||
      (bloco && linha.includes(`BL ${bloco} UN ${unidade}`))
    ) {
      // Pegar linha atual + próximas 3 linhas
      linhasRelevantes.push(
        linhas[i],
        linhas[i + 1] || '',
        linhas[i + 2] || '',
        linhas[i + 3] || ''
      );
      break;
    }
  }

  const textoRelevante = linhasRelevantes.join(' ');

  // Extrair todos os valores
  const valores = [];
  let match;
  while ((match = regexValor.exec(textoRelevante)) !== null) {
    const valorStr = match[1].replace(/\./g, '').replace(',', '.');
    const valor = parseFloat(valorStr);
    if (!isNaN(valor) && valor > 0) {
      valores.push(valor);
    }
  }

  // Heurística: assumir que há 3-4 valores (principal, multa, juros, total)
  // Total geralmente é o maior valor
  if (valores.length === 0) {
    return {
      valorTotal: 0,
      valorPrincipal: 0,
      valorMulta: 0,
      valorJuros: 0
    };
  }

  valores.sort((a, b) => b - a); // Ordenar decrescente

  const valorTotal = valores[0] || 0;
  const valorPrincipal = valores[1] || valorTotal * 0.7;
  const valorMulta = valores[2] || valorTotal * 0.15;
  const valorJuros = valores[3] || valorTotal * 0.15;

  return {
    valorTotal,
    valorPrincipal,
    valorMulta,
    valorJuros
  };
}

module.exports = { buscarUnidade, extrairValores };
