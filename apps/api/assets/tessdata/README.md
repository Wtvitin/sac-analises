# Tesseract OCR Language Data (Português)

Este diretório contém o modelo de linguagem offline para OCR em português utilizado pela biblioteca `tesseract.js` no SAC Análises.

* **Arquivo:** `por.traineddata`
* **Origem:** Repositório oficial [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)
* **Licença:** Apache License 2.0 (Copyright 2018 Google Inc. e colaboradores do Tesseract OCR)
* **Versão:** 4.0.0 (Fast integer models)
* **Tamanho:** 2.422.444 bytes
* **Checksum SHA-256:** `42fab1f017aedab69b92bdecc01bbb11166cd3b177575612ee860f8e2825ece0`

A presença deste arquivo garante que o serviço de extração de documentos opere de maneira 100% reproduzível, determinística e offline, sem requisições para CDNs externas em runtime e sem gerar arquivos desordenados na raiz da aplicação.
