import styles from './ProjectCrane.module.css'

export function ProjectCrane() {
  return (
    <div aria-hidden="true" className={styles.crane}>
      <div className={styles.ground} />
      <div className={styles.mast} />
      <div className={styles.peak} />
      <div className={styles.counterStay} />
      <div className={styles.jibStay} />
      <div className={styles.jib} />
      <div className={styles.counterweight} />
      <div className={styles.cab} />
      <div className={styles.hoist} />
    </div>
  )
}
