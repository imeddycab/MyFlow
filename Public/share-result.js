// Comparte un archivo de texto cuando el navegador lo admite; si no, lo descarga.
async function shareResultFile(text, filename, title, button, status) {
  const file = new File([text], filename, { type: 'text/plain' })
  const download = () => {
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  button.disabled = true
  status.textContent = ''
  try {
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title })
      status.textContent = 'El archivo se entregó al sistema para compartir.'
    } else {
      download()
      status.textContent = 'Este navegador no permite compartir archivos. Se descargó el .txt.'
    }
  } catch (error) {
    status.textContent = error.name === 'AbortError'
      ? 'Se cerró el selector sin compartir.'
      : 'No se pudo compartir. Puedes intentar de nuevo o descargar el .txt.'
    if (error.name !== 'AbortError') {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'share-result-button'
      retry.textContent = 'Descargar .txt'
      retry.addEventListener('click', download)
      status.appendChild(retry)
    }
  } finally {
    button.disabled = false
  }
}
