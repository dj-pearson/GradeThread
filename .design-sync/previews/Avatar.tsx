import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from 'gradethread'

const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center' }

export function Sizes() {
  return (
    <div style={row}>
      <Avatar size="sm"><AvatarFallback>DP</AvatarFallback></Avatar>
      <Avatar><AvatarFallback>GT</AvatarFallback></Avatar>
      <Avatar size="lg"><AvatarFallback>JR</AvatarFallback></Avatar>
    </div>
  )
}

export function Group() {
  return (
    <AvatarGroup>
      <Avatar><AvatarFallback>DP</AvatarFallback></Avatar>
      <Avatar><AvatarFallback>JR</AvatarFallback></Avatar>
      <Avatar><AvatarFallback>MK</AvatarFallback></Avatar>
      <AvatarGroupCount>+3</AvatarGroupCount>
    </AvatarGroup>
  )
}
