import React from 'react'
import ReactDOM from 'react-dom/client'
import { Desk } from './components/Desk'
import './styles/books.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Desk />
  </React.StrictMode>,
)
