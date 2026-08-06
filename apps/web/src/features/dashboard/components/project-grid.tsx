import { ProjectCard } from "./project-card"

interface ProjectGridProps {
  projects: readonly React.ComponentProps<typeof ProjectCard>["project"][]
}

export function ProjectGrid({ projects }: ProjectGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  )
}
