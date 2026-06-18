import { useState } from 'react'
import ParticipantSelect from './screens/ParticipantSelect.jsx'
import Record from './screens/Record.jsx'

export default function App() {
  const [participant, setParticipant] = useState(null)

  if (participant) {
    return <Record participant={participant} onBack={() => setParticipant(null)} />
  }

  return <ParticipantSelect onSelect={setParticipant} />
}
