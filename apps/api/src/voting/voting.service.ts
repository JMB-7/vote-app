import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { hashCredential, newOpaqueCredential } from '../auth/credentials.js'
import { MODERATOR_ACTOR } from '../auth/auth.service.js'
import { RealtimeGateway } from '../realtime/realtime.gateway.js'
import type { AssemblyStatus, RoundStatus } from '../generated/prisma/enums.js'
import type { CreateRoundDto } from './dtos.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'

@Injectable()
export class VotingService {
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeGateway) {}

  async createAssembly(name: string) {
    const joinCode = newOpaqueCredential()
    const joinCodeHash = hashCredential(joinCode)
    await this.prisma.organization.upsert({
      where: { id: ORGANIZATION_ID },
      create: { id: ORGANIZATION_ID, name: 'Unión Hondureña ASDMR', type: 'union' },
      update: {},
    })
    const assembly = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ORGANIZATION_ID}::uuid FOR UPDATE`
      const liveAssembly = await tx.assembly.findFirst({
        where: { organizationId: ORGANIZATION_ID, status: { in: ['lobby_open', 'lobby_closed', 'in_progress'] } },
        select: { id: true },
      })
      if (liveAssembly) throw new ConflictException('Ya existe una Asamblea activa')
      const created = await tx.assembly.create({
        data: { organizationId: ORGANIZATION_ID, name: name.trim(), status: 'lobby_open', joinCodeHash },
        select: { id: true, name: true, status: true },
      })
      await tx.auditEvent.create({
        data: { assemblyId: created.id, actorRef: MODERATOR_ACTOR, action: 'assembly.created_and_lobby_opened' },
      })
      return created
    })
    this.realtime.assemblyState(assembly.id, { status: assembly.status })
    this.realtime.lobbyState(assembly.id, { status: 'open', participantCount: 0 })
    const url = new URL(process.env.PUBLIC_APP_URL!)
    url.searchParams.set('join', joinCode)
    return { assemblyId: assembly.id, name: assembly.name, status: assembly.status, joinCode, joinUrl: url.toString() }
  }

  async joinAssembly(assemblyCode: string, firstName: string, lastName: string) {
    const participantSessionToken = newOpaqueCredential()
    const assemblyCodeHash = hashCredential(assemblyCode)
    const tokenHash = hashCredential(participantSessionToken)
    const joined = await this.prisma.$transaction(async (tx) => {
      const assemblies = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE join_code_hash = ${assemblyCodeHash} FOR UPDATE
      `
      const assembly = assemblies[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status !== 'lobby_open') throw new ConflictException('El ingreso a la sala está cerrado')
      const participant = await tx.participantSession.create({
        data: {
          assemblyId: assembly.id,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          tokenHash,
        },
        select: { id: true, assemblyId: true, firstName: true, lastName: true },
      })
      const count = await tx.participantSession.count({ where: { assemblyId: assembly.id, status: 'active' } })
      return { participant, count }
    })
    this.realtime.participantJoined(joined.participant.assemblyId, {
      participantId: joined.participant.id,
      firstName: joined.participant.firstName,
      lastName: joined.participant.lastName,
    })
    this.realtime.lobbyState(joined.participant.assemblyId, { status: 'open', participantCount: joined.count })
    const state = await this.participantState(joined.participant.id)
    this.realtime.participantState(joined.participant.id, state)
    return {
      participantSessionToken,
      participant: { firstName: joined.participant.firstName, lastName: joined.participant.lastName },
      ...state,
    }
  }

  async participantState(participantId: string) {
    const participant = await this.prisma.participantSession.findUnique({
      where: { id: participantId },
      include: { assembly: { select: { status: true, completedAt: true } } },
    })
    if (!participant || participant.status !== 'active') throw new NotFoundException('Sesión no encontrada')
    const round = await this.prisma.round.findFirst({
      where: { assemblyId: participant.assemblyId, status: { in: ['open', 'closed', 'published'] } },
      orderBy: { createdAt: 'desc' },
      include: { options: { orderBy: { order: 'asc' }, select: { id: true, label: true } } },
    })
    const participation = round
      ? await this.prisma.participation.findUnique({
          where: { roundId_participantSessionId: { roundId: round.id, participantSessionId: participant.id } },
          select: { id: true },
        })
      : null
    const openRound = round
      ? { roundId: round.id, status: round.status, title: round.title, options: round.options.map((o) => ({ optionId: o.id, label: o.label })) }
      : null
    const results = round?.status === 'published' ? await this.publishedResults(round.id) : undefined
    return {
      assemblyStatus: participant.assembly.status,
      assemblyCompletedAt: participant.assembly.completedAt?.toISOString() ?? null,
      lobbyStatus: participant.assembly.status === 'lobby_open' ? 'open' as const : 'closed' as const,
      openRound,
      participationStatus: participation ? 'recorded' as const : 'pending' as const,
      ...(results ? { results } : {}),
    }
  }

  async castVote(participantId: string, roundId: string, optionId: string) {
    const participant = await this.prisma.participantSession.findUnique({
      where: { id: participantId },
      select: { id: true, assemblyId: true, status: true },
    })
    if (!participant || participant.status !== 'active') throw new ForbiddenException()
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string }>>`
          SELECT id, assembly_id, status FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
        `
        const round = rows[0]
        if (!round) throw new NotFoundException('Ronda no encontrada')
        if (round.assembly_id !== participant.assemblyId) throw new NotFoundException('Ronda no encontrada')
        if (round.status !== 'open') throw new ConflictException('La papeleta no está abierta')
        const option = await tx.ballotOption.findFirst({ where: { id: optionId, roundId }, select: { id: true } })
        if (!option) throw new UnprocessableEntityException('Opción no válida para esta papeleta')
        // The unique participation claim and anonymous ballot share a transaction but no shared identity key.
        // If either insert fails, PostgreSQL rolls both back.
        await tx.participation.create({ data: { roundId, participantSessionId: participant.id } })
        await tx.anonymousVote.create({ data: { roundId, optionId } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya se registró una participación para esta ronda')
      }
      throw error
    }
    const [state, recorded, eligible] = await Promise.all([
      this.participantState(participantId),
      this.prisma.participation.count({ where: { roundId } }),
      this.prisma.participantSession.count({ where: { assemblyId: participant.assemblyId, status: 'active' } }),
    ])
    this.realtime.participantState(participantId, state)
    this.realtime.participationCount(participant.assemblyId, { roundId, recorded, eligible })
    return { accepted: true, participationStatus: 'recorded' as const }
  }

  async publicState(assemblyCode: string) {
    const assembly = await this.prisma.assembly.findUnique({
      where: { joinCodeHash: hashCredential(assemblyCode) },
      include: {
        rounds: { where: { status: { in: ['open', 'closed', 'published'] } }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    if (!assembly) throw new NotFoundException('Asamblea no encontrada')
    const [round, participantCount] = await Promise.all([
      Promise.resolve(assembly.rounds[0]),
      this.prisma.participantSession.count({ where: { assemblyId: assembly.id, status: 'active' } }),
    ])
    const result = round?.status === 'published' ? await this.publishedResults(round.id) : undefined
    return {
      assembly: { id: assembly.id, name: assembly.name, status: assembly.status, completedAt: assembly.completedAt?.toISOString() ?? null },
      participantCount,
      round: round ? { id: round.id, title: round.title, status: round.status } : null,
      ...(result ? { results: result } : {}),
    }
  }

  async moderatorAssembly(assemblyId: string) {
    const assembly = await this.prisma.assembly.findUnique({
      where: { id: assemblyId },
      include: {
        participants: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' }, select: { id: true, firstName: true, lastName: true, status: true, joinedAt: true } },
        rounds: { orderBy: { createdAt: 'asc' }, include: { options: { orderBy: { order: 'asc' } }, _count: { select: { participations: true } } } },
      },
    })
    if (!assembly) throw new NotFoundException('Asamblea no encontrada')
    const rounds = await Promise.all(assembly.rounds.map(async (round) => ({
      id: round.id,
      title: round.title,
      format: round.format,
      countingRule: round.countingRule,
      status: round.status,
      options: round.options,
      participationCount: round._count.participations,
      ...(round.status === 'published' ? { results: await this.publishedResults(round.id) } : {}),
    })))
    return {
      id: assembly.id,
      name: assembly.name,
      status: assembly.status,
      completedAt: assembly.completedAt?.toISOString() ?? null,
      participants: assembly.participants,
      participantCount: assembly.participants.length,
      rounds,
    }
  }

  async changeLobby(assemblyId: string, status: 'lobby_open' | 'lobby_closed') {
    if (status === 'lobby_open') throw new ForbiddenException('La reapertura está deshabilitada hasta validación de Secretaría/mesa')
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten cambios operativos')
      if (assembly.status === 'lobby_closed' || assembly.status === 'in_progress') return { id: assembly.id, status: assembly.status, changed: false }
      if (assembly.status !== 'lobby_open') throw new ConflictException('La Asamblea no permite cerrar el ingreso')
      const updated = await tx.assembly.update({ where: { id: assemblyId }, data: { status: 'lobby_closed' }, select: { id: true, status: true } })
      await tx.auditEvent.create({ data: { assemblyId, actorRef: MODERATOR_ACTOR, action: 'lobby.closed' } })
      return { ...updated, changed: true }
    })
    if (!result.changed) return { id: result.id, status: result.status }
    const count = await this.prisma.participantSession.count({ where: { assemblyId, status: 'active' } })
    this.realtime.assemblyState(assemblyId, { status: result.status as AssemblyStatus })
    this.realtime.lobbyState(assemblyId, { status: 'closed', participantCount: count })
    return result
  }

  async completeAssembly(assemblyId: string, confirmation: true) {
    const completed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: AssemblyStatus; completed_at: Date | null; updated_at: Date }>>`
        SELECT id, status, completed_at, updated_at FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') {
        return { id: assembly.id, status: assembly.status, completedAt: assembly.completed_at ?? assembly.updated_at, changed: false }
      }
      if (assembly.status === 'preparing') throw new ConflictException('La Asamblea aún no ha comenzado y no puede finalizarse')
      const openRound = await tx.round.findFirst({ where: { assemblyId, status: 'open' }, select: { id: true } })
      if (openRound) throw new ConflictException('Cierra la papeleta abierta antes de finalizar la Asamblea')
      if (confirmation !== true) throw new UnprocessableEntityException('Confirma explícitamente la finalización de la Asamblea')
      const completedAt = new Date()
      const updated = await tx.assembly.update({
        where: { id: assemblyId },
        data: { status: 'completed', completedAt },
        select: { id: true, status: true, completedAt: true },
      })
      await tx.auditEvent.create({
        data: { assemblyId, actorRef: MODERATOR_ACTOR, action: 'assembly.completed', occurredAt: completedAt },
      })
      return { id: updated.id, status: updated.status, completedAt, changed: true }
    })
    if (completed.changed) {
      this.realtime.assemblyState(assemblyId, { status: 'completed', completedAt: completed.completedAt.toISOString() })
    }
    return { id: completed.id, status: completed.status, completedAt: completed.completedAt.toISOString() }
  }

  async patchParticipant(participantId: string, input: { firstName?: string; lastName?: string; status?: 'removed' }) {
    const identity = await this.prisma.participantSession.findUnique({ where: { id: participantId }, select: { assemblyId: true } })
    if (!identity) throw new NotFoundException('Participante no encontrado')
    if (input.firstName === undefined && input.lastName === undefined && input.status === undefined) {
      throw new UnprocessableEntityException('Indica un nombre para corregir o status: removed')
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${identity.assemblyId}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: identity.assemblyId }, select: { status: true } })
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten cambios operativos')
      const hasVoted = await tx.participation.count({ where: { participantSessionId: participantId } }) > 0
      if (assembly.status === 'in_progress' || hasVoted) throw new ConflictException('La lista ya no admite cambios después de iniciar las rondas')
      const current = await tx.participantSession.findUnique({ where: { id: participantId }, select: { id: true } })
      if (!current) throw new NotFoundException('Participante no encontrado')
      const value = await tx.participantSession.update({
        where: { id: participantId },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName.trim() } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName.trim() } : {}),
          ...(input.status === 'removed' ? { status: 'removed' as const } : {}),
        },
        select: { id: true, assemblyId: true, firstName: true, lastName: true, status: true },
      })
      await tx.auditEvent.create({ data: { assemblyId: identity.assemblyId, actorRef: MODERATOR_ACTOR, action: input.status === 'removed' ? 'participant.removed' : 'participant.corrected', metadata: { participantId } } })
      return value
    })
    if (updated.status === 'removed') {
      this.realtime.participantRemoved(updated.assemblyId, updated.id)
      const count = await this.prisma.participantSession.count({ where: { assemblyId: updated.assemblyId, status: 'active' } })
      const assembly = await this.prisma.assembly.findUniqueOrThrow({ where: { id: updated.assemblyId }, select: { status: true } })
      this.realtime.lobbyState(updated.assemblyId, { status: assembly.status === 'lobby_open' ? 'open' : 'closed', participantCount: count })
    } else this.realtime.participantUpdated(updated.assemblyId, { participantId: updated.id, firstName: updated.firstName, lastName: updated.lastName })
    return { id: updated.id, firstName: updated.firstName, lastName: updated.lastName, status: updated.status }
  }

  async createRound(assemblyId: string, input: CreateRoundDto) {
    if (!input.countingRule || Array.isArray(input.countingRule) || Object.keys(input.countingRule).length === 0) {
      throw new UnprocessableEntityException('countingRule debe declarar explícitamente la regla configurada')
    }
    if (input.countingRule.kind !== 'count_only') throw new UnprocessableEntityException('La única regla compatible con V1 es kind: count_only; no se determina un ganador')
    const labels = input.options.map(({ label }) => label.trim())
    if (labels.some((label) => !label) || new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
      throw new UnprocessableEntityException('Las opciones deben tener etiquetas no vacías y distintas')
    }
    const round = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten nuevas papeletas')
      if (!['lobby_closed', 'in_progress'].includes(assembly.status)) throw new ConflictException('Cierra el ingreso antes de preparar una papeleta')
      const created = await tx.round.create({
        data: {
          assemblyId,
          title: input.title.trim(),
          format: 'single_choice',
          countingRule: input.countingRule as Prisma.InputJsonValue,
          options: { create: labels.map((label, order) => ({ label, order })) },
        },
        include: { options: { orderBy: { order: 'asc' } } },
      })
      await tx.auditEvent.create({ data: { assemblyId, roundId: created.id, actorRef: MODERATOR_ACTOR, action: 'round.prepared' } })
      return created
    })
    return { id: round.id, title: round.title, format: round.format, countingRule: round.countingRule, status: round.status, options: round.options }
  }

  async openRound(roundId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rounds = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string }>>`
        SELECT id, assembly_id, status FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rounds[0]
      if (!round) throw new NotFoundException('Ronda no encontrada')
      if (round.status === 'open') return { roundId: round.id, assemblyId: round.assembly_id, status: 'open' as const, changed: false }
      if (round.status !== 'draft') throw new ConflictException('La ronda no se puede abrir desde su estado actual')
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${round.assembly_id}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: round.assembly_id }, select: { status: true } })
      if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden abrir papeletas')
      if (!assembly || !['lobby_closed', 'in_progress'].includes(assembly.status)) throw new ConflictException('El ingreso debe estar cerrado antes de abrir una papeleta')
      const otherOpen = await tx.round.findFirst({ where: { assemblyId: round.assembly_id, status: 'open' }, select: { id: true } })
      if (otherOpen) throw new ConflictException('Ya hay una papeleta abierta')
      const updated = await tx.round.update({ where: { id: round.id }, data: { status: 'open', openedAt: new Date() }, select: { id: true, assemblyId: true, title: true } })
      if (assembly.status === 'lobby_closed') await tx.assembly.update({ where: { id: round.assembly_id }, data: { status: 'in_progress' } })
      await tx.auditEvent.create({ data: { assemblyId: round.assembly_id, roundId: round.id, actorRef: MODERATOR_ACTOR, action: 'round.opened' } })
      return { roundId: updated.id, assemblyId: updated.assemblyId, title: updated.title, status: 'open' as const, changed: true }
    })
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, include: { options: { orderBy: { order: 'asc' } } } })
    const payload = { roundId, status: 'open' as const, title: round!.title }
    if (result.changed) {
      this.realtime.roundState(result.assemblyId, payload)
      this.realtime.roundOpened(result.assemblyId, { ...payload, options: round!.options.map((option) => ({ optionId: option.id, label: option.label })) })
      this.realtime.assemblyState(result.assemblyId, { status: 'in_progress' })
    }
    return payload
  }

  async closeRound(roundId: string) {
    const round = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string }>>`
        SELECT id, assembly_id, status FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const current = rows[0]
      if (!current) throw new NotFoundException('Ronda no encontrada')
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${current.assembly_id}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: current.assembly_id }, select: { status: true } })
      if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden modificar sus papeletas')
      if (current.status === 'closed' || current.status === 'published') return { id: current.id, assemblyId: current.assembly_id, status: current.status, changed: false }
      if (current.status !== 'open') throw new ConflictException('Solo se puede cerrar una papeleta abierta')
      const updated = await tx.round.update({ where: { id: roundId }, data: { status: 'closed', closedAt: new Date() }, select: { id: true, assemblyId: true, status: true } })
      await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: 'round.closed' } })
      return { ...updated, changed: true }
    })
    const [recorded, eligible, title] = await Promise.all([
      this.prisma.participation.count({ where: { roundId } }),
      this.prisma.participantSession.count({ where: { assemblyId: round.assemblyId, status: 'active' } }),
      this.prisma.round.findUniqueOrThrow({ where: { id: roundId }, select: { title: true } }),
    ])
    const payload = { roundId, status: round.status as RoundStatus, title: title.title }
    if (round.changed) {
      this.realtime.roundState(round.assemblyId, payload)
      if (round.status === 'closed') this.realtime.roundClosed(round.assemblyId, roundId)
      this.realtime.participationCount(round.assemblyId, { roundId, recorded, eligible })
    }
    return { roundId, status: round.status, participation: { recorded, eligible } }
  }

  async publishRound(roundId: string) {
    const current = await this.prisma.round.findUnique({ where: { id: roundId }, select: { id: true, assemblyId: true, status: true, title: true } })
    if (!current) throw new NotFoundException('Ronda no encontrada')
    if (current.status !== 'closed' && current.status !== 'published') throw new ConflictException('Cierra la papeleta antes de publicar resultados')
    let publishedNow = false
    if (current.status === 'closed') {
      await this.prisma.$transaction(async (tx) => {
        const roundRows = await tx.$queryRaw<Array<{ assembly_id: string }>>`SELECT assembly_id FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE`
        if (!roundRows[0]) throw new NotFoundException('Ronda no encontrada')
        await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${roundRows[0].assembly_id}::uuid FOR UPDATE`
        const assembly = await tx.assembly.findUnique({ where: { id: roundRows[0].assembly_id }, select: { status: true } })
        if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden modificar sus resultados')
        const latest = await tx.round.findUniqueOrThrow({ where: { id: roundId }, select: { status: true } })
        if (latest.status === 'published') return
        if (latest.status !== 'closed') throw new ConflictException('La papeleta debe estar cerrada para publicar')
        await tx.round.update({ where: { id: roundId }, data: { status: 'published', publishedAt: new Date() } })
        await tx.auditEvent.create({ data: { assemblyId: current.assemblyId, roundId, actorRef: MODERATOR_ACTOR, action: 'round.results_published' } })
        publishedNow = true
      })
    }
    const results = await this.publishedResults(roundId)
    if (!publishedNow) return { roundId, status: 'published', results }
    const payload = { roundId, options: results }
    this.realtime.roundState(current.assemblyId, { roundId, status: 'published', title: current.title })
    this.realtime.resultsPublished(current.assemblyId, payload)
    return { roundId, status: 'published', results }
  }

  private async publishedResults(roundId: string) {
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { status: true } })
    if (!round || round.status !== 'published') throw new NotFoundException('Resultados no publicados')
    const [options, counts] = await Promise.all([
      this.prisma.ballotOption.findMany({ where: { roundId }, orderBy: { order: 'asc' }, select: { id: true, label: true } }),
      this.prisma.anonymousVote.groupBy({ by: ['optionId'], where: { roundId }, _count: { _all: true } }),
    ])
    const countByOption = new Map(counts.map((row) => [row.optionId, row._count._all]))
    return options.map((option) => ({ optionId: option.id, label: option.label, count: countByOption.get(option.id) ?? 0 }))
  }
}
