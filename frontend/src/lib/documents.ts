const storeName = 'files'

function openDocuments(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('billbuild-documents', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function writeDocuments(write: (store: IDBObjectStore) => void) {
  const db = await openDocuments()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      write(transaction.objectStore(storeName))
    })
  } finally {
    db.close()
  }
}

export function saveDocument(id: string, file: File) {
  const type = /\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream'
  return writeDocuments((store) => store.put(file.slice(0, file.size, type), id))
}

export async function loadDocument(id: string): Promise<Blob | undefined> {
  const db = await openDocuments()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export function removeDocuments(ids: string[]) {
  if (!ids.length) return
  void writeDocuments((store) => ids.forEach((id) => store.delete(id))).catch(console.error)
}

export function clearDocuments() {
  return writeDocuments((store) => store.clear())
}
